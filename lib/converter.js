import { exec, spawn } from 'child_process'
import progress from 'progress'

import { basename, dirname, resolve } from 'path';
import { promises, readFileSync } from 'fs';

import util from 'util'

import moment from 'moment'
import cliProgress from 'cli-progress'

import mkdirp from 'mkdirp'

import dateFormat from 'dateformat'

import _ from 'lodash'

const getFiles = async function* (dir) {
    const dirents = await promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        const res = resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
            yield* getFiles(res);
        } else {
            if (!dirent.name.startsWith('._') && dirent.name.endsWith('.mpg')) {
                yield res;
            }
        }
    }
}

// Call mediainfo to get frame count
const countFrames = async (record) => {
    const result = await util.promisify(exec)(`mediainfo --Output="Video;%FrameCount%" "${record.file}"`)
    record.frames = parseInt(result.stdout.trim())
}

// Run comskip
const callComskip = async (record) => {

    const start = moment()

    const produce = spawn('comskip', ['-q', '--ini', './comskip.ini', record.file])

    const bar = new progress('  Running comskip [:bar] :percent :etas', { total: record.frames });

    produce.stderr.on('data', data => {
        const datar = data.toString()
        const match = datar.match(/([\d]*) frames/)
        if (!bar.complete && match && match.length > 0) {
            const frame = parseInt(match[1])
            bar.update(frame / record.frames)
        }
    });

    await new Promise((resolve, reject) => {
        produce.on('exit', resolve);
    });

    const finish = moment()
    console.log(`${dateFormat(new Date(), 'mm-dd-yyyy HH:MM')}: Finished processing in ${finish.diff(start, 'seconds')} seconds`)
}

// Parse the pytivo file
const readPytivo = async (record) => {

    const lines = (await promises.readFile(record.file + '.txt', 'utf-8')).split('\n')
    const mapped = _.omitBy(
        _.fromPairs(
            _.map(lines, line => {
                return _.split(line, ' : ')
            })
        ),
        entry => {
            return entry === undefined
        }
    )

    // Season info isn't actually in the pytivo output, but it is in the path.
    const episodeInfo = record.file_base.match(/ S([\d]*)E([\d]*) /)
    record.season = parseInt(episodeInfo[1])
    record.episode = parseInt(episodeInfo[2])

    _.merge(record, mapped)
}

// Generate the new mp4 with metadata
const callFFMPEG = async (record) => {

    const start = moment()

    //const produce = spawn('ffmpeg', ['-r', '60', '-pattern_type', 'glob', '-i', '*.png', '-c:v', 'libx265', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p10le', `../processed/${name}.mp4`], { cwd: '/pool/view_data/temp/' })

    // ./ffmpeg_edl_ac3.sh -i [input] -vcodec h264 -profile:v high -level 4.2 -preset slower -crf 19 -vf "yadif" -edl [edl] [output]
    
    const produce = spawn('./ffmpeg_edl_ac3.sh', ['-i', record.file, '-vcodec', 'h264', '-profile:v', 'high', '-level', '4.2', '-preset', 'slow',
        '-metadata', `title=${record.episodeTitle}`,
        '-metadata', `artist=${record.seriesTitle}`,
        '-metadata', `album_artist=${record.seriesTitle}`,
        '-metadata', `album=${record.seriesTitle}, Season ${record.season}`,
        '-metadata', `comment=${record.description}`,
        '-metadata', `description=${record.description}`,
        '-metadata', `track=${record.episode}`,
        '-metadata', `show=${record.seriesTitle}`,
        '-metadata', `episode_id=${record.programId}`,
        '-metadata', `network=${record.callsign}`,
        '-metadata', `hd_video=2`,
        '-metadata', `media_type=10`,
        '-crf', '19', '-vf', 'yadif', '-edl', `${record.file_base}.edl`, record.output_file])

    let frameCounter = 0

    const bar = new cliProgress.SingleBar({
        format: 'Encoding [{bar}] | ETA: {eta}s | {value}/{total}%',
        stopOnComplete: true,
        barsize: 120,
    }, cliProgress.Presets.shades_grey);
    bar.start(100, 0);

    produce.stdout.on('data', data => {
        const datar = data.toString().trim()
        //console.log(datar)

        const match = datar.match(/^([\d\.]*) %/)
        //console.log(match)
        if (match && match.length > 0) {
            const percent = parseFloat(match[1])
            //console.log(percent)
            bar.update(percent)
        }
    });

    const exitCode = await new Promise((resolve, reject) => {
        produce.on('exit', resolve);
    });

    const finish = moment()
    console.log(`\n${dateFormat(new Date(), 'mm-dd-yyyy HH:MM')}: Finished processing in ${finish.diff(start, 'minutes')} minutes`)
}

// Move into the plex directory
const moveToPlex = async (record) => {
    await mkdirp(record.destination_path)
    await promises.copyFile(record.output_file, record.destination_file)
}

const cleanup = async (record) => {
    await promises.rm(record.file)
    await promises.rm(record.output_file)
    await promises.rm(record.file_base + ".edl")
    await promises.rm(record.file_base + ".log")
    await promises.rm(record.file_base + ".txt")
    await promises.rm(record.file_base + ".mpg.txt")

    try {
        await promises.rmdir(record.file_base + "_ffmpeg", { recursive: true })
    } catch(e) {
        
    }
}

const ROOT_DIR = '/space/tivo/'
const PLEX_DIR = '/space/plex_libraries/'
const KIDS_TV_PATH = 'kids/tv/'
const loop = async () => {
    for await (const f of getFiles(ROOT_DIR + KIDS_TV_PATH)) {
        
        const file_name = basename(f, 'mpg') + 'mp4'
        const file_base = dirname(f) + '/' + basename(f, '.mpg')
        const build_file = `${file_base}.mp4`
        const build_path = `${dirname(f)}`
        const relative_path = build_path.substring((ROOT_DIR + KIDS_TV_PATH).length)
        const record = {
            cwd: dirname(f),
            file_base: file_base,
            file: f,
            output_file: build_file,
            destination_file: `${PLEX_DIR}${KIDS_TV_PATH}${relative_path}/${file_name}`,
            relative_path: relative_path,
            destination_path: `${PLEX_DIR}${KIDS_TV_PATH}${relative_path}/`,
            segment: KIDS_TV_PATH,
        }

        await countFrames(record)
        await callComskip(record)
        await readPytivo(record)
        console.log(record)
        await callFFMPEG(record)
        // move to plex
        await moveToPlex(record)
        //clean up temp files
        await cleanup(record)
    }
}

loop();
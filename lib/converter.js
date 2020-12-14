import { exec, spawn } from 'child_process'

import { basename, dirname, resolve } from 'path';
import { promises } from 'fs';

import util from 'util'

import moment from 'moment'
import cliProgress from 'cli-progress'

import mkdirp from 'mkdirp'

import dateFormat from 'dateformat'

import { ROOT_DIR, PLEX_DIR, KIDS_TV_PATH } from './config.js'
import { cleanupRoot } from './cleanup.js'

import _ from 'lodash'

const getFiles = async function* (dir) {
    const dirents = await promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        const res = resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
            yield* getFiles(res);
        } else {
            if (!dirent.name.startsWith('._') &&
                (dirent.name.endsWith('.mpg.txt') || dirent.name.endsWith('.ts.txt'))) {
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

    const bar = new cliProgress.SingleBar({
        format: 'Detecting commercials... [{bar}] | ETA: {eta}s | {value}/{total}%',
        stopOnComplete: true,
        barsize: 120,
    }, cliProgress.Presets.shades_grey);
    bar.start(record.frames, 0);

    produce.stderr.on('data', data => {
        const datar = data.toString()
        const match = datar.match(/([\d]*) frames/)
        if (!bar.complete && match && match.length > 0) {
            const frame = parseInt(match[1])
            bar.update(frame)
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
    const episodeInfo = record.file_base.match(/ S([\d]*)E([\d]*)/)
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

    const bar = new cliProgress.SingleBar({
        format: 'Converting to h264... [{bar}] | ETA: {eta}s | {value}/{total}%',
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
            bar.update(parseFloat(match[1]))
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

const cleanupAfterRun = async (record) => {

    const errored = error => {
        console.log(`Cleanup of temp files in ${record.cwd} failed`)
    }

    await promises.rm(record.file).catch(errored)
    await promises.rm(record.output_file).catch(errored)
    await promises.rm(record.file_base + ".edl").catch(errored)
    await promises.rm(record.file_base + ".log").catch(errored)
    await promises.rm(record.file_base + ".txt").catch(errored)
    await promises.rm(record.file_base + (record.is_ts ? ".ts.txt" : ".mpg.txt")).catch(errored)
    await promises.rmdir(record.file_base + "_ffmpeg", { recursive: true }).catch(errored)
}

const run_once = async (segment) => {
    for await (const f of getFiles(ROOT_DIR + segment)) {
        const is_ts = f.endsWith('.ts.txt')

        const pytivo_file = f
        const pretty_name = basename(f, '.txt')
        const mpg_file = dirname(f) + '/' + pretty_name
        const file_name = basename(mpg_file, is_ts ? 'ts' : 'mpg') + 'mp4'
        const file_base = dirname(f) + '/' + basename(pretty_name, is_ts ? '.ts' : '.mpg')
        const build_file = `${file_base}.mp4`
        const build_path = `${dirname(f)}`
        const relative_path = build_path.substring((ROOT_DIR + segment).length)
        const record = {
            is_ts: is_ts,
            cwd: dirname(f),
            file_base: file_base,
            file: mpg_file,
            pytivo_file: pytivo_file,
            output_file: build_file,
            destination_file: `${PLEX_DIR}${segment}${relative_path}/${file_name}`,
            relative_path: relative_path,
            destination_path: `${PLEX_DIR}${segment}${relative_path}/`,
            segment: segment,
        }

        console.log(`Processing ${pretty_name}`)
        await readPytivo(record)
        console.log(record)
        /*
        await countFrames(record)
        await callComskip(record)
        await callFFMPEG(record)
        // move to plex
        await moveToPlex(record)
        //clean up temp files
        await cleanupAfterRun(record)
        */
    }
}

const loop = async () => {
    while (true) {
        await run_once(KIDS_TV_PATH)
        await cleanupRoot()
        await new Promise(r => setTimeout(r, 60000))
    }
}

loop();

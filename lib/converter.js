import { exec, spawn } from 'child_process'

import { basename, dirname, join, resolve } from 'path';
import { promises } from 'fs';

import util from 'util'

import moment from 'moment'
import cliProgress from 'cli-progress'

import mkdirp from 'mkdirp'

import dateFormat from 'dateformat'

import { ROOT_DIR, PLEX_DIR, SEGMENTS } from './config.js'
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
    const result = await util.promisify(exec)(`mediainfo --Output="Video;%FrameCount%" "${record.fully_qualified_path_to_original_file}"`)
    record.frames = parseInt(result.stdout.trim())
}

// Run comskip
const callComskip = async (record) => {

    const start = moment()

    //const produce = spawn('comskip', ['-q', '--ini', './comskip.ini', record.fully_qualified_path_to_original_file])
    const produce = spawn('comskip', ['-q', '--ini', './comskip_ncaa.ini', record.fully_qualified_path_to_original_file])

    const bar = new cliProgress.SingleBar({
        format: 'Detecting commercials... [{bar}] | ETA: {eta}s | {value}/{total} frames',
        stopOnComplete: true,
        barsize: 100,
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

    // if comskip was confused and thought the whole thing was a commercial, delete the edl file
    const comskipBody = await promises.readFile(`${record.fully_qualified_path_no_extension}.edl`, 'utf-8');
    if (comskipBody) {
        const lines = comskipBody.trim().split('\n');
        if (lines.length === 1) {
            const parts = lines[0].split('\t');
            if (parts[2] === '0' || parts[2] === '3') {
                console.log("Thinks the whole thing is to cut.");
                await promises.rm(`${record.fully_qualified_path_no_extension}.edl`);
            }
        }
    }
}

// Parse the pytivo file
const readPytivo = async (record) => {

    const lines = (await promises.readFile(record.fully_qualified_path_to_pytivo_file, 'utf-8')).split('\n')
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

    // Season info isn't actually in the pytivo output, but it is in the path for many shows.
    const episodeInfo = record.filename_with_no_extension.match(/ S([\d]*)E([\d]*)/)
    if (episodeInfo) {
        record.season = parseInt(episodeInfo[1])
        record.episode = parseInt(episodeInfo[2])
    } else {
        // Hmm, let's test instead for a season or some other date in the path
        record.season = basename(join(record.fully_qualified_path_to_output_file, '..'))
        record.episode = record.filename_with_no_extension
    }

    _.merge(record, mapped)
}

// Generate the new mkv with metadata
const callFFMPEG = async (record) => {

    const start = moment()

    const produce = spawn('./ffmpeg_edl_ac3.sh', ['-i', record.fully_qualified_path_to_original_file,
        '-vcodec', 'libx265', '-preset', 'fast',
        //'-vcodec', 'copy', '-acodec', 'copy',
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
        '-noAC3',
        '-noStereo',
        '-threads', '16',
        '-map', '0:a:0',
        '-c:a', 'libfdk_aac',
        '-b:a', '768k',
        '-ac', '6',
        '-metadata:s:a:0', 'language=eng',
        '-crf', '19', '-vf', 'yadif',
        '-edl', `${record.fully_qualified_path_no_extension}.edl`,
        record.fully_qualified_path_to_output_file])

    const bar = new cliProgress.SingleBar({
        format: 'Converting to h265... [{bar}] | ETA: {eta}s | {value}/{total}%',
        stopOnComplete: true,
        barsize: 100,
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
    await mkdirp(record.fully_qualified_destination_path)
    await promises.copyFile(record.fully_qualified_path_to_output_file, record.fully_qualified_path_to_destination_file)
}

const cleanupAfterRun = async (record) => {

    const errored = error => {
        console.log(`Cleanup of temp files in ${record.cwd} failed`)
    }

    try {
        await promises.rm(record.fully_qualified_path_to_original_file).catch(errored)
        await promises.rm(record.fully_qualified_path_to_output_file).catch(errored)
        await promises.rm(record.fully_qualified_path_no_extension + ".edl").catch(errored)
        await promises.rm(record.fully_qualified_path_no_extension + ".log").catch(errored)
        await promises.rm(record.fully_qualified_path_no_extension + ".txt").catch(errored)
        await promises.rm(record.fully_qualified_path_no_extension + ".logo.txt").catch(errored)
        await promises.rm(record.fully_qualified_path_no_extension + (record.original_is_ts ? ".ts.txt" : ".mpg.txt")).catch(errored)
        await promises.rmdir(record.fully_qualified_path_no_extension + "_ffmpeg", { recursive: true }).catch(errored)
    } catch(e) {
        console.log(e)
    }
}

const process_file = async (segment, f) => {

    const fully_qualified_path_to_pytivo_file = f
    const original_directory = dirname(fully_qualified_path_to_pytivo_file)

    const original_filename = basename(fully_qualified_path_to_pytivo_file, '.txt')
    const original_is_ts = original_filename.endsWith('.ts')
    const fully_qualified_path_to_original_file = `${original_directory}/${original_filename}`

    const filename_with_no_extension = basename(fully_qualified_path_to_original_file, original_is_ts ? '.ts' : '.mpg')
    const fully_qualified_path_no_extension = `${original_directory}/${filename_with_no_extension}`

    const output_file_name = `${filename_with_no_extension}.mp4`
    //const output_file_name = `${filename_with_no_extension}_edl.mpg`
    const fully_qualified_path_to_output_file = `${original_directory}/${output_file_name}`

    const relative_path = original_directory.substring((ROOT_DIR + segment).length)
    const fully_qualified_destination_path = `${PLEX_DIR}${segment}${relative_path}`
    const fully_qualified_path_to_destination_file = `${fully_qualified_destination_path}/${output_file_name}`

    const record = {
        original_is_ts: original_is_ts,
        cwd: original_directory,
        original_filename: original_filename,
        filename_with_no_extension: filename_with_no_extension,
        fully_qualified_path_to_original_file: fully_qualified_path_to_original_file,
        fully_qualified_path_no_extension: fully_qualified_path_no_extension,
        fully_qualified_path_to_pytivo_file: fully_qualified_path_to_pytivo_file,
        fully_qualified_path_to_output_file: fully_qualified_path_to_output_file,
        relative_path: relative_path,
        fully_qualified_destination_path: fully_qualified_destination_path,
        fully_qualified_path_to_destination_file: fully_qualified_path_to_destination_file,
    }

    console.log(`Processing ${filename_with_no_extension} in ${segment}`)
    await readPytivo(record)
    await countFrames(record)
    return record
}

const run_once = async (segment) => {
    for await (let f of getFiles(ROOT_DIR + segment)) {
        const record = await process_file(segment, f)
        await callComskip(record)
        await callFFMPEG(record)
        // move to plex
        await moveToPlex(record)
        //clean up temp files
        await cleanupAfterRun(record)
    }
}

if (process.argv.length === 2) {
    const loop = async () => {
        while (true) {
            for await (const segment of SEGMENTS) {
                await run_once(segment)
                await cleanupRoot()
            }

            await new Promise(r => setTimeout(r, 60000))
            //process.exit(0)
        }
    }

    loop();
} else {
    const segment = process.argv[2]
    for await (const f of getFiles(ROOT_DIR + segment)) {
        const record = await process_file(segment, f)
        console.log(record)
        //await callComskip(record)
        //await callFFMPEG(record, true)
    }
}

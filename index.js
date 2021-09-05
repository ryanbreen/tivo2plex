import { run, processFile } from './lib/converter.js'

import { cleanupRoot } from './lib/cleanup.js'

import { SEGMENTS } from './lib/config.js'

process.on("uncaughtException", (error) => {
    console.error(`Uncaught Exception ${error.message}`);
});

if (process.argv.length === 2) {
    const loop = async () => {
        while (true) {
            for await (const segment of SEGMENTS) {
                await run(segment)
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
        const record = await processFile(segment, f)
        console.log(record)
        //await callComskip(record)
        //await callFFMPEG(record, true)
    }
}

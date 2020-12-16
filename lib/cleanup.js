
import { resolve } from 'path';
import { promises } from 'fs';

import { ROOT_DIR, SEGMENTS } from './config.js'

const getDotFiles = async function* (dir) {
    const dirents = await promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        const res = resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
            yield* getDotFiles(res);
        } else if (dirent.name.startsWith('._')) {
            yield res;
        }
    }
}

const purgeDotFiles = async () => {

    const errored = error => {
        console.log('Cleanup of dot files failed')
    }

    for await (const f of getDotFiles(ROOT_DIR)) {
        await promises.rm(f).catch(errored)
    }
}

const getDirs = async function* (dir) {
    const dirents = await promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        const res = resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
            yield* getDirs(res);
            if (dirent.name != '.') {
                yield res;
            }
        }
    }
}

const purgeEmptyDirs = async () => {
    const errored = error => {
        console.log('Cleanup of empty dirs failed')
    }

    for await (const segment of SEGMENTS) {

        for await (const f of getDirs(ROOT_DIR + segment)) {
            const dirents = await promises.readdir(f, { withFileTypes: true });
            if (dirents.length === 0) {
                await promises.rmdir(f).catch(errored)
            }
        }
    }
}

// Clean all dot files and delete empty directories
export const cleanupRoot = async () => {
    await purgeDotFiles()
    await purgeEmptyDirs()
}

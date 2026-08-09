import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, '../packages/cli/package.json'), 'utf8')) as {
    version: string;
};
const tag = process.argv[2];

if (!tag) throw new Error('release tag is required');
if (tag !== `v${manifest.version}`) {
    throw new Error(`release tag ${tag} does not match package version v${manifest.version}`);
}
console.log(`${tag} matches cross-session-summary@${manifest.version}`);

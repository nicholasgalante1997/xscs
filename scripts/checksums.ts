import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const verify = process.argv.includes('--verify');
const directoryArgument = process.argv.slice(2).find((argument) => argument !== '--verify');
const directory = resolve(directoryArgument ?? 'release');
const output = resolve(directory, 'SHA256SUMS');
const files = readdirSync(directory)
    .filter((name) => name.startsWith('xscs-') && name !== basename(output))
    .sort();

if (!files.length) throw new Error(`no release artifacts found in ${directory}`);

if (verify) {
    const expected = new Map(
        readFileSync(output, 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
                const [digest, name] = line.split(/\s+/, 2);
                return [name, digest] as const;
            }),
    );
    for (const name of files) {
        const actual = digest(name);
        if (expected.get(name) !== actual) throw new Error(`checksum mismatch for ${name}`);
    }
    if (expected.size !== files.length) throw new Error('checksum manifest does not match the artifact set');
    console.log(`verified ${files.length} artifact checksum(s)`);
    process.exit(0);
}

const lines = files.map((name) => {
    return `${digest(name)}  ${name}`;
});
writeFileSync(output, `${lines.join('\n')}\n`, 'utf8');
console.log(`wrote ${output} for ${files.length} artifact(s)`);

function digest(name: string): string {
    return createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex');
}

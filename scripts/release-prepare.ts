import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
    digest,
    gitState,
    inspectPackResult,
    manifestPathForTarball,
    metadataWarnings,
    output,
    packageManifest,
    type PackResult,
    RELEASE_DIR,
    type ReleaseManifest,
    releaseTag,
    ROOT,
    run,
    smokePackage,
    versionExists,
} from './release/lib';

const requestedVersion = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const allowDirty = process.argv.includes('--allow-dirty');
const skipRegistry = process.argv.includes('--skip-registry');
const manifest = packageManifest();
if (!requestedVersion) throw new Error('usage: bun scripts/release-prepare.ts <version> [--allow-dirty] [--skip-registry]');
if (requestedVersion !== manifest.version) {
    throw new Error(`requested ${requestedVersion}, but package.json contains ${manifest.version}`);
}

const git = gitState();
if (git.dirty && !allowDirty) throw new Error('release preparation requires a clean worktree');
if (!skipRegistry && versionExists(manifest.name, manifest.version)) {
    throw new Error(`${manifest.name}@${manifest.version} already exists on npm`);
}

run(['bun', 'install', '--frozen-lockfile']);
run(['mise', 'run', 'verify']);
run(['mise', 'run', 'prerelease-check']);
run(['mise', 'run', 'benchmark-hooks']);

mkdirSync(RELEASE_DIR, { recursive: true });
const expectedName = `${manifest.name}-${manifest.version}.tgz`;
const expectedTarball = resolve(RELEASE_DIR, expectedName);
if (existsSync(expectedTarball)) throw new Error(`release artifact already exists: ${expectedTarball}`);
const packedOutput = run(['npm', 'pack', '--json', '--pack-destination', RELEASE_DIR], { cwd: resolve(ROOT, 'packages/cli'), quiet: true });
const packed = (JSON.parse(packedOutput) as PackResult[])[0];
if (!packed) throw new Error('npm pack returned no artifact');
inspectPackResult(packed, manifest);
const tarball = resolve(RELEASE_DIR, packed.filename);
smokePackage(tarball, manifest.version);
run(['npm', 'publish', tarball, '--access', 'public', '--tag', releaseTag(manifest.version), '--dry-run']);

const warnings = metadataWarnings(manifest);
const release: ReleaseManifest = {
    schema: 1,
    package: manifest.name,
    version: manifest.version,
    tag: releaseTag(manifest.version),
    commit: git.commit,
    dirty: git.dirty,
    createdAt: new Date().toISOString(),
    tarball: basename(tarball),
    sha256: digest(tarball, 'sha256'),
    sha512: digest(tarball, 'sha512'),
    npmIntegrity: packed.integrity,
    npmShasum: packed.shasum,
    packedBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
    files: packed.files,
    tools: {
        bun: output(['bun', '--version']),
        node: output(['node', '--version']),
        npm: output(['npm', '--version']),
    },
    metadataWarnings: warnings,
};
writeFileSync(manifestPathForTarball(tarball), `${JSON.stringify(release, null, 2)}\n`, 'utf8');
writeFileSync(resolve(RELEASE_DIR, 'SHA256SUMS'), `${release.sha256}  ${release.tarball}\n`, 'utf8');
writeFileSync(resolve(RELEASE_DIR, 'SHA512SUMS'), `${release.sha512}  ${release.tarball}\n`, 'utf8');

console.log(`\nprepared ${manifest.name}@${manifest.version}`);
console.log(`artifact: ${tarball}`);
console.log(`manifest: ${manifestPathForTarball(tarball)}`);
console.log(`commit:   ${git.commit}${git.dirty ? ' (DIRTY — publishing will be refused)' : ''}`);
for (const warning of warnings) console.warn(`warning: ${warning}`);
console.log(`\nPublish only after review:\n  mise run release-publish -- ${tarball} --confirm ${manifest.name}@${manifest.version}`);

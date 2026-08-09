import { resolve } from 'node:path';

import {
    gitState,
    packageManifest,
    readReleaseManifest,
    releaseTag,
    ROOT,
    run,
    verifyReleaseArtifact,
    versionExists,
} from './release/lib';

const tarballArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
if (!tarballArgument) throw new Error('usage: bun scripts/release-publish.ts <tarball> [--dry-run] --confirm <name@version>');
const tarball = resolve(tarballArgument);
const release = readReleaseManifest(tarball);
const pkg = packageManifest();
verifyReleaseArtifact(tarball, release);
if (release.dirty) throw new Error('refusing to publish an artifact prepared from a dirty worktree');
if (release.metadataWarnings.length) {
    throw new Error(`refusing to publish with incomplete package metadata: ${release.metadataWarnings.join('; ')}`);
}
if (pkg.name !== release.package || pkg.version !== release.version) throw new Error('current package metadata differs from release manifest');
const git = gitState();
if (git.dirty) throw new Error('publishing requires a clean worktree');
if (git.commit !== release.commit) throw new Error(`current commit ${git.commit} differs from prepared commit ${release.commit}`);
if (release.tag !== releaseTag(release.version)) throw new Error('release manifest has an invalid npm tag');
if (versionExists(release.package, release.version)) throw new Error(`${release.package}@${release.version} already exists on npm`);

const account = run(['npm', 'whoami'], { quiet: true }).trim();
console.log(`npm account: ${account}`);
if (!dryRun) {
    const confirmIndex = process.argv.indexOf('--confirm');
    const confirmation = confirmIndex === -1 ? undefined : process.argv[confirmIndex + 1];
    if (confirmation !== `${release.package}@${release.version}`) {
        throw new Error(`publishing requires --confirm ${release.package}@${release.version}`);
    }
}

run([
    'npm',
    'publish',
    tarball,
    '--access',
    pkg.publishConfig?.access ?? 'public',
    '--tag',
    release.tag,
    ...(dryRun ? ['--dry-run'] : []),
]);
if (dryRun) {
    console.log(`dry-run publish passed for ${release.package}@${release.version}`);
} else {
    run(['bun', resolve(ROOT, 'scripts/release-verify.ts'), `${release.package}@${release.version}`]);
}

import { packageManifest, releaseTag, run, smokePackage } from './release/lib';

const pkg = packageManifest();
const spec = process.argv[2] ?? `${pkg.name}@${pkg.version}`;
const separator = spec.lastIndexOf('@');
if (separator <= 0) throw new Error('usage: bun scripts/release-verify.ts <name@version>');
const name = spec.slice(0, separator);
const version = spec.slice(separator + 1);
const metadata = JSON.parse(run(['npm', 'view', spec, '--json'], { quiet: true })) as { name?: string; version?: string };
if (metadata.name !== name || metadata.version !== version) throw new Error(`registry returned unexpected metadata for ${spec}`);
const tags = JSON.parse(run(['npm', 'dist-tag', 'ls', name, '--json'], { quiet: true })) as Record<string, string>;
const expectedTag = releaseTag(version);
if (tags[expectedTag] !== version) throw new Error(`npm tag ${expectedTag} points to ${tags[expectedTag] ?? 'nothing'}, expected ${version}`);
if (expectedTag !== 'latest' && tags.latest === version) throw new Error(`prerelease ${version} unexpectedly changed the latest tag`);
smokePackage(spec, version);
console.log(`registry verification passed for ${spec} (${expectedTag})`);

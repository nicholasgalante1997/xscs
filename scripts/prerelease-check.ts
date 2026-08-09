import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PackFile {
    path: string;
}

interface PackResult {
    files: PackFile[];
}

const ROOT = resolve(import.meta.dir, '..');
const PACKAGE_DIR = resolve(ROOT, 'packages/cli');
const manifest = JSON.parse(readFileSync(resolve(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    bin: Record<string, string>;
    dependencies?: Record<string, string>;
};

const failures: string[] = [];

if (manifest.name !== 'cross-session-summary') failures.push(`unexpected package name: ${manifest.name}`);
if (!manifest.version.startsWith('0.2.0-')) failures.push(`expected a 0.2.0 prerelease, received ${manifest.version}`);

for (const [name, target] of Object.entries(manifest.bin)) {
    if (!target.startsWith('./dist/') || !target.endsWith('.js')) {
        failures.push(`${name} must target built JavaScript in dist (received ${target})`);
    } else if (!existsSync(resolve(PACKAGE_DIR, target))) {
        failures.push(`${name} target does not exist: ${target}`);
    }
}

for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (version.startsWith('workspace:')) failures.push(`public runtime dependency ${name} uses ${version}`);
}

const packed = Bun.spawnSync(['npm', 'pack', '--dry-run', '--json'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, npm_config_cache: resolve(process.env.TMPDIR ?? '/tmp', 'xscs-npm-cache') },
    stderr: 'pipe',
    stdout: 'pipe',
});
if (packed.exitCode !== 0) {
    failures.push(`npm pack failed: ${packed.stderr.toString().trim()}`);
} else {
    const result = (JSON.parse(packed.stdout.toString()) as PackResult[])[0];
    const paths = result?.files.map((file) => file.path) ?? [];
    const allowed = new Set([
        'dist/xscs.js',
        'dist/xscs.node.js',
        'dist/client/app.js',
        'README.md',
        'CHANGELOG.md',
        'LICENSE',
        'package.json',
    ]);
    for (const path of allowed) if (!paths.includes(path)) failures.push(`tarball is missing ${path}`);
    for (const path of paths) {
        if (!allowed.has(path)) failures.push(`tarball contains unexpected file ${path}`);
    }
}

const versions = [
    Bun.spawnSync(['bun', resolve(PACKAGE_DIR, manifest.bin['xscs-bun']!), '--version']),
    Bun.spawnSync(['node', resolve(PACKAGE_DIR, manifest.bin.xscs!), '--version']),
];
for (const result of versions) {
    if (result.exitCode !== 0) failures.push(`version command failed: ${result.stderr.toString().trim()}`);
    if (!result.stdout.toString().includes(manifest.version)) {
        failures.push(`version output does not contain ${manifest.version}: ${result.stdout.toString().trim()}`);
    }
}

if (failures.length) {
    for (const failure of failures) console.error(`prerelease check failed: ${failure}`);
    process.exit(1);
}

console.log(`cross-session-summary@${manifest.version} prerelease checks passed`);

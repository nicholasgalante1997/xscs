import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '../..');
export const PACKAGE_DIR = resolve(ROOT, 'packages/cli');
export const RELEASE_DIR = resolve(ROOT, 'release/npm');
const NPM_CACHE = resolve(tmpdir(), 'xscs-npm-cache');

export interface PackageManifest {
    name: string;
    version: string;
    bin: Record<string, string>;
    publishConfig?: { access?: string; registry?: string; tag?: string };
    repository?: unknown;
    homepage?: string;
    bugs?: unknown;
}

export interface PackResult {
    filename: string;
    files: Array<{ path: string; size: number }>;
    integrity: string;
    name: string;
    shasum: string;
    size: number;
    unpackedSize: number;
    version: string;
}

export interface ReleaseManifest {
    schema: 1;
    package: string;
    version: string;
    tag: string;
    commit: string;
    dirty: boolean;
    createdAt: string;
    tarball: string;
    sha256: string;
    sha512: string;
    npmIntegrity: string;
    npmShasum: string;
    packedBytes: number;
    unpackedBytes: number;
    files: Array<{ path: string; size: number }>;
    tools: { bun: string; node: string; npm: string };
    metadataWarnings: string[];
}

export const ALLOWED_PACKAGE_FILES = new Set([
    'dist/xscs.js',
    'dist/xscs.node.js',
    'dist/client/app.js',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'package.json',
]);

export function packageManifest(): PackageManifest {
    return JSON.parse(readFileSync(resolve(PACKAGE_DIR, 'package.json'), 'utf8')) as PackageManifest;
}

export function run(
    command: string[],
    options: { cwd?: string; env?: Record<string, string>; quiet?: boolean; stdin?: string } = {},
): string {
    if (!options.quiet) console.log(`$ ${command.join(' ')}`);
    const result = Bun.spawnSync(command, {
        cwd: options.cwd ?? ROOT,
        env: {
            ...process.env,
            ...(command[0] === 'npm' ? { npm_config_cache: NPM_CACHE } : {}),
            ...options.env,
        },
        stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    if (result.exitCode !== 0) {
        throw new Error(`${command.join(' ')} exited ${result.exitCode}\n${stderr || stdout}`.trim());
    }
    if (!options.quiet && stdout.trim()) process.stdout.write(stdout);
    if (!options.quiet && stderr.trim()) process.stderr.write(stderr);
    return stdout;
}

export function output(command: string[], cwd = ROOT): string {
    return run(command, { cwd, quiet: true }).trim();
}

export function gitState(): { commit: string; dirty: boolean } {
    return {
        commit: output(['git', 'rev-parse', 'HEAD']),
        dirty: output(['git', 'status', '--porcelain']).length > 0,
    };
}

export function releaseTag(version: string): string {
    const channel = version.match(/-(alpha|beta|rc)(?:\.|$)/)?.[1];
    return channel ?? 'latest';
}

export function digest(file: string, algorithm: 'sha256' | 'sha512'): string {
    return createHash(algorithm).update(readFileSync(file)).digest('hex');
}

export function inspectPackResult(result: PackResult, expected: PackageManifest): void {
    if (result.name !== expected.name || result.version !== expected.version) {
        throw new Error(`packed ${result.name}@${result.version}, expected ${expected.name}@${expected.version}`);
    }
    const paths = new Set(result.files.map((file) => file.path));
    for (const path of ALLOWED_PACKAGE_FILES) if (!paths.has(path)) throw new Error(`tarball is missing ${path}`);
    for (const path of paths) if (!ALLOWED_PACKAGE_FILES.has(path)) throw new Error(`tarball contains unexpected file ${path}`);
}

export function metadataWarnings(manifest: PackageManifest): string[] {
    const warnings: string[] = [];
    if (!manifest.repository) warnings.push('package.json has no repository metadata');
    if (!manifest.homepage) warnings.push('package.json has no homepage');
    if (!manifest.bugs) warnings.push('package.json has no bugs URL');
    return warnings;
}

export function versionExists(name: string, version: string): boolean {
    const result = Bun.spawnSync(['npm', 'view', `${name}@${version}`, 'version', '--json'], {
        cwd: ROOT,
        env: { ...process.env, npm_config_cache: NPM_CACHE },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    if (result.exitCode === 0) return result.stdout.toString().trim().length > 0;
    const error = result.stderr.toString();
    if (/E404|is not in this registry|No match found/i.test(error)) return false;
    throw new Error(`npm registry lookup failed: ${error.trim()}`);
}

export function smokePackage(source: string, expectedVersion: string): void {
    const temporary = mkdtempSync(resolve(tmpdir(), 'xscs-release-smoke-'));
    const installRoot = resolve(temporary, 'install');
    const storeHome = resolve(temporary, 'store');
    const cache = resolve(temporary, 'npm-cache');
    const env = { npm_config_cache: cache, XSCS_DISTILLER: 'none', XSCS_HOME: storeHome };
    try {
        run(['npm', 'install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', source], { env });
        const packageRoot = resolve(installRoot, 'node_modules/cross-session-summary');
        const nodeEntry = resolve(packageRoot, 'dist/xscs.node.js');
        const bunEntry = resolve(packageRoot, 'dist/xscs.js');
        const extension = process.platform === 'win32' ? '.cmd' : '';
        for (const name of [`xscs${extension}`, `xscs-bun${extension}`]) {
            if (!existsSync(resolve(installRoot, 'node_modules/.bin', name))) throw new Error(`npm did not expose ${name}`);
        }
        expectVersion(['node', nodeEntry, '--version'], expectedVersion, env);
        expectVersion(['mise', 'exec', 'node@24.0.0', '--', 'node', nodeEntry, '--version'], expectedVersion, env);
        expectVersion(['bun', bunEntry, '--version'], expectedVersion, env);
        run(['mise', 'exec', 'node@24.0.0', '--', 'node', nodeEntry, 'remember', '--title', 'release tarball smoke', '--body', 'Node and Bun share this store.', '--json'], { env });
        const found = run(['bun', bunEntry, 'search', 'release tarball smoke', '--json'], { env, quiet: true });
        if (!found.includes('release tarball smoke')) throw new Error('Bun did not read the item written by Node 24.0.0');
        const mcp = run(['node', nodeEntry, 'mcp'], {
            env,
            quiet: true,
            stdin: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
        });
        if (!mcp.includes('"name":"xscs"')) throw new Error(`installed MCP initialization failed: ${mcp}`);
        const hook = run(['bun', bunEntry, 'hook', '--agent', 'kiro', '--event', 'SessionStart', '--no-background'], {
            env: { ...env, KIRO_SESSION_ID: 'release-smoke-kiro' },
            quiet: true,
            stdin: JSON.stringify({ hook_event_name: 'agentSpawn', cwd: temporary }),
        });
        if (hook.startsWith('{')) throw new Error('installed Kiro hook did not use its plain-text output contract');
    } finally {
        rmSync(temporary, { force: true, recursive: true });
    }
}

export function manifestPathForTarball(tarball: string): string {
    return tarball.replace(/\.tgz$/, '.manifest.json');
}

export function readReleaseManifest(tarball: string): ReleaseManifest {
    const path = manifestPathForTarball(tarball);
    if (!existsSync(path)) throw new Error(`release manifest not found: ${path}`);
    return JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest;
}

export function verifyReleaseArtifact(tarball: string, manifest: ReleaseManifest): void {
    if (!existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`);
    if (basename(tarball) !== manifest.tarball) throw new Error('manifest tarball name does not match artifact');
    if (digest(tarball, 'sha256') !== manifest.sha256) throw new Error('tarball SHA-256 does not match manifest');
    if (digest(tarball, 'sha512') !== manifest.sha512) throw new Error('tarball SHA-512 does not match manifest');
}

function expectVersion(command: string[], version: string, env: Record<string, string>): void {
    const actual = run(command, { env, quiet: true });
    if (!actual.includes(version)) throw new Error(`${command.join(' ')} did not report ${version}: ${actual.trim()}`);
}

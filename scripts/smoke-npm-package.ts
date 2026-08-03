import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

interface PackResult {
    filename: string;
}

const ROOT = resolve(import.meta.dir, '..');
const PACKAGE_DIR = resolve(ROOT, 'packages/cli');
const manifest = JSON.parse(await Bun.file(resolve(PACKAGE_DIR, 'package.json')).text()) as { version: string };
const temporary = mkdtempSync(resolve(tmpdir(), 'xscs-npm-smoke-'));
const installRoot = resolve(temporary, 'install');
const storeHome = resolve(temporary, 'store');
const cache = resolve(temporary, 'npm-cache');
const env = { ...process.env, npm_config_cache: cache, XSCS_DISTILLER: 'none', XSCS_HOME: storeHome };

try {
    const packed = spawn(['npm', 'pack', '--json', '--pack-destination', temporary], PACKAGE_DIR);
    const filename = (JSON.parse(packed.stdout) as PackResult[])[0]?.filename;
    if (!filename) throw new Error(`npm pack returned no filename: ${packed.stdout}`);
    const tarball = resolve(temporary, filename);

    spawn(['npm', 'install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', tarball], ROOT);

    const extension = process.platform === 'win32' ? '.cmd' : '';
    const nodeBin = resolve(installRoot, 'node_modules/.bin', `xscs${extension}`);
    const bunBin = resolve(installRoot, 'node_modules/.bin', `xscs-bun${extension}`);
    if (!existsSync(nodeBin) || !existsSync(bunBin)) throw new Error('npm did not expose both xscs binaries');

    expectOutput(spawn([nodeBin, '--version'], ROOT).stdout, new RegExp(escapeRegExp(manifest.version)));
    expectOutput(spawn([bunBin, '--version'], ROOT).stdout, new RegExp(escapeRegExp(manifest.version)));
    expectOutput(
        spawn([nodeBin, 'remember', '--title', 'npm installation smoke', '--body', 'Both bins share this store.', '--json'], ROOT)
            .stdout,
        /"created": true/,
    );
    expectOutput(spawn([bunBin, 'search', 'installation smoke', '--json'], ROOT).stdout, /npm installation smoke/);
    console.log('installed npm tarball smoke passed for xscs and xscs-bun');
} finally {
    rmSync(temporary, { force: true, recursive: true });
}

function spawn(command: string[], cwd: string): { stderr: string; stdout: string } {
    const result = Bun.spawnSync(command, { cwd, env, stderr: 'pipe', stdout: 'pipe' });
    const stderr = result.stderr.toString();
    const stdout = result.stdout.toString();
    if (result.exitCode !== 0) throw new Error(`${command.join(' ')} exited ${result.exitCode}: ${stderr}`);
    return { stderr, stdout };
}

function expectOutput(output: string, expected: RegExp): void {
    if (!expected.test(output)) throw new Error(`output did not match ${expected}: ${output}`);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

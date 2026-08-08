import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { PACKAGE_DIR, packageManifest, type PackResult, run, smokePackage } from './release/lib';

const temporary = mkdtempSync(resolve(tmpdir(), 'xscs-npm-smoke-'));
try {
    const packed = JSON.parse(
        run(['npm', 'pack', '--json', '--pack-destination', temporary], { cwd: PACKAGE_DIR, quiet: true }),
    ) as PackResult[];
    const filename = packed[0]?.filename;
    if (!filename) throw new Error('npm pack returned no filename');
    smokePackage(resolve(temporary, filename), packageManifest().version);
    console.log('installed npm tarball smoke passed for xscs and xscs-bun');
} finally {
    rmSync(temporary, { force: true, recursive: true });
}

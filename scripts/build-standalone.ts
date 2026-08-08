import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type StandaloneTarget =
    | 'bun-darwin-arm64'
    | 'bun-darwin-x64-baseline'
    | 'bun-linux-arm64'
    | 'bun-linux-x64-baseline'
    | 'bun-windows-x64-baseline';

interface Artifact {
    filename: string;
    target: StandaloneTarget;
}

const ROOT = resolve(import.meta.dir, '..');
const OUTPUT_DIR = resolve(ROOT, 'release');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'packages/cli/package.json'), 'utf8')) as { version: string };
const client = readFileSync(resolve(ROOT, 'apps/dashboard/dist/client/app.js'), 'utf8');

const artifacts: Artifact[] = [
    { target: 'bun-darwin-arm64', filename: 'xscs-darwin-arm64' },
    { target: 'bun-darwin-x64-baseline', filename: 'xscs-darwin-x64' },
    { target: 'bun-linux-arm64', filename: 'xscs-linux-arm64' },
    { target: 'bun-linux-x64-baseline', filename: 'xscs-linux-x64' },
    { target: 'bun-windows-x64-baseline', filename: 'xscs-windows-x64.exe' },
];

const requested = readOption('--target');
const selected = requested
    ? artifacts.filter((artifact) => artifact.target === requested || artifact.filename === requested)
    : artifacts;
if (!selected.length) throw new Error(`unknown standalone target: ${requested}`);

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const artifact of selected) {
    const outfile = resolve(OUTPUT_DIR, artifact.filename);
    console.log(`Compiling ${artifact.filename}...`);
    await compileWithRetry(artifact, outfile);
}

async function compileWithRetry(artifact: Artifact, outfile: string, attempt = 1): Promise<void> {
    const result = await Bun.build({
        entrypoints: [resolve(ROOT, 'packages/cli/index.ts')],
        compile: {
            target: artifact.target,
            outfile,
            autoloadBunfig: false,
            autoloadDotenv: false,
            autoloadPackageJson: false,
            autoloadTsconfig: false,
        },
        define: {
            XSCS_EMBEDDED_DASHBOARD_CLIENT: JSON.stringify(client),
            XSCS_VERSION: JSON.stringify(manifest.version),
        },
        minify: true,
        packages: 'bundle',
        sourcemap: 'none',
    }).catch((error: unknown) => {
        // Bun's cross-compile target download is occasionally interrupted on CI
        // runners (esp. windows), producing a truncated executable extraction.
        if (attempt < 3 && String(error).includes('download may be incomplete')) return null;
        throw error;
    });
    if (result === null) {
        console.warn(`Retrying ${artifact.filename} (attempt ${attempt + 1}) after incomplete target download...`);
        return compileWithRetry(artifact, outfile, attempt + 1);
    }
    if (!result.success) throw new AggregateError(result.logs, `failed to compile ${artifact.filename}`);
}

function readOption(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    if (index !== -1) return process.argv[index + 1];
    const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
    return inline?.slice(name.length + 1);
}

import { createBaseConfig, runBuild } from '@xscs/internal-build-utils';

export {};

try {
    const outputs = await runBuild({
        label: '@xscs/dashboard',
        configs: [
            {
                ...createBaseConfig(),
                entrypoints: ['index.ts'],
                naming: { entry: 'index.js' },
            },
            {
                ...createBaseConfig({
                    minify: true,
                    outdir: 'dist/client',
                    packages: 'bundle',
                    target: 'browser',
                }),
                entrypoints: ['src/client/main.tsx'],
                naming: { entry: 'app.js' },
                define: { 'process.env.NODE_ENV': '"production"' },
            },
        ],
    });
    for (const build of outputs) {
        for (const output of build.outputs) {
            const bytes = (await output.arrayBuffer()).byteLength;
            console.log(`- ${output.path.split('/dashboard/')[1] ?? output.path} (${bytes} bytes)`);
        }
    }
} catch (error) {
    console.error('Build failed:', error);
    await Bun.$`rm -rf ./dist`;
    process.exit(1);
}

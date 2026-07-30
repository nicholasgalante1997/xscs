import { createBaseConfig, runBuild } from '@xscs/internal-build-utils';

export {};

try {
    await runBuild({
        label: '@xscs/cli',
        configs: [
            {
                ...createBaseConfig(),
                entrypoints: ['index.ts'],
                naming: { entry: 'xscs.js' },
            },
        ],
    });
    await Bun.$`chmod +x ./dist/xscs.js`;
} catch (error) {
    console.error('Build failed:', error);
    await Bun.$`rm -rf ./dist`;
    process.exit(1);
}

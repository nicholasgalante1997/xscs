import { createBaseConfig, runBuild } from '@xscs/internal-build-utils';

export {};

try {
    await runBuild({
        label: '@xscs/core',
        configs: [
            {
                ...createBaseConfig(),
                entrypoints: ['index.ts', 'bun.ts', 'node.ts'],
                naming: { entry: '[name].js' },
            },
        ],
    });
} catch (error) {
    console.error('Build failed:', error);
    await Bun.$`rm -rf ./dist`;
    process.exit(1);
}

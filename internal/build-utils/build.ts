export {};

try {
    const result = await Bun.build({
        entrypoints: ['index.ts'],
        format: 'esm',
        target: 'bun',
        outdir: 'dist',
        naming: { entry: 'index.js' },
        packages: 'external',
        sourcemap: 'external',
    });
    if (!result.success) throw new AggregateError(result.logs, 'bundle failed');
} catch (error) {
    console.error('Build failed:', error);
    await Bun.$`rm -rf ./dist`;
    process.exit(1);
}

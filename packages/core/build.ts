export {};

try {
    console.log('Starting build for @xscs/core...');
    const start = performance.now();
    const result = await Bun.build({
        entrypoints: ['index.ts'],
        format: 'esm',
        target: 'bun',
        minify: false,
        outdir: 'dist',
        naming: { entry: 'index.js' },
        splitting: false,
        packages: 'external',
        sourcemap: 'external',
    });
    // `Bun.build` resolves rather than throwing on a failed bundle, so without
    // this the script would report success while emitting nothing.
    if (!result.success) throw new AggregateError(result.logs, 'bundle failed');
    console.log('Build finished in ' + (performance.now() - start).toFixed(2) + 'ms');
} catch (e) {
    console.error('Build failed: ', e);
    await Bun.$`rm -rf ./dist`;
    process.exit(1);
}

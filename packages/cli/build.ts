export {};

try {
    console.log('Starting build for @xscs/cli...');
    const start = performance.now();
    const result = await Bun.build({
        entrypoints: ['index.ts'],
        format: 'esm',
        target: 'bun',
        outdir: 'dist',
        naming: { entry: 'xscs.js' },
        splitting: false,
        // Workspace deps stay external so the CLI loads their built dist rather
        // than inlining a stale copy of the core engine.
        packages: 'external',
        // No `banner` here: the shebang in index.ts is already preserved by the
        // bundler, and adding it again puts a second one mid-file.
        sourcemap: 'external',
    });
    if (!result.success) throw new AggregateError(result.logs, 'bundle failed');

    await Bun.$`chmod +x ./dist/xscs.js`;
    console.log('Build finished in ' + (performance.now() - start).toFixed(2) + 'ms');
} catch (e) {
    console.error('Build failed: ', e);
    await Bun.$`rm -rf ./dist`;
    process.exit(1);
}

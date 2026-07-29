export {};

try {
    console.log('Starting build for @xscs/dashboard...');
    const start = performance.now();

    // Server half: bun target, workspace deps external so it loads @xscs/core's
    // own dist rather than inlining a second copy of the engine.
    const server = await Bun.build({
        entrypoints: ['index.ts'],
        format: 'esm',
        target: 'bun',
        outdir: 'dist',
        naming: { entry: 'index.js' },
        splitting: false,
        packages: 'external',
        sourcemap: 'external',
    });
    if (!server.success) throw new AggregateError(server.logs, 'server bundle failed');

    // Client half: browser target, React bundled in. `serveDashboard` looks for
    // this file next to itself, so the naming and outdir are load-bearing.
    const client = await Bun.build({
        entrypoints: ['src/client/main.tsx'],
        format: 'esm',
        target: 'browser',
        outdir: 'dist/client',
        naming: { entry: 'app.js' },
        minify: true,
        splitting: false,
        sourcemap: 'external',
        define: { 'process.env.NODE_ENV': '"production"' },
    });
    if (!client.success) throw new AggregateError(client.logs, 'client bundle failed');

    console.log('Build finished in ' + (performance.now() - start).toFixed(2) + 'ms');
    for (const output of [...server.outputs, ...client.outputs]) {
        console.log(`- ${output.path.split('/dashboard/')[1] ?? output.path} (${(await output.arrayBuffer()).byteLength} bytes)`);
    }
} catch (e) {
    console.error('Build failed: ', e);
    await Bun.$`rm -rf ./dist`;
    process.exit(1);
}

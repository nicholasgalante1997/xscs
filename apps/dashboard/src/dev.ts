import { configureDatabasePlatform, configureProcessPlatform, configureServerPlatform } from '@xscs/core';
import { bunDatabasePlatform, bunProcessPlatform, bunServerPlatform } from '@xscs/core/bun';

import { serveDashboard } from './server';

// `bun run --hot src/dev.ts` — the client bundle is rebuilt in memory on each
// server restart, so there is no watcher to keep in sync.
configureDatabasePlatform(bunDatabasePlatform);
configureProcessPlatform(bunProcessPlatform);
configureServerPlatform(bunServerPlatform);
await serveDashboard({
    port: Number(process.env.PORT ?? 4319),
    open: false,
    async buildClient(entry) {
        const result = await Bun.build({
            entrypoints: [entry],
            target: 'browser',
            format: 'esm',
            minify: false,
            define: { 'process.env.NODE_ENV': '"development"' },
        });
        if (!result.success) throw new AggregateError(result.logs, 'dashboard client build failed');
        return result.outputs[0]!.text();
    },
});

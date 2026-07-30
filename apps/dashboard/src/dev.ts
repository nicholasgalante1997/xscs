import { configureDatabasePlatform } from '@xscs/core';
import { bunDatabasePlatform } from '@xscs/core/bun';

import { serveDashboard } from './server';

// `bun run --hot src/dev.ts` — the client bundle is rebuilt in memory on each
// server restart, so there is no watcher to keep in sync.
configureDatabasePlatform(bunDatabasePlatform);
await serveDashboard({ port: Number(process.env.PORT ?? 4319), open: false });

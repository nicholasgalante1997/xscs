#!/usr/bin/env node

import { configureDatabasePlatform, configureProcessPlatform, configureServerPlatform } from '@xscs/core';
import {
    assertNodeSqliteCapabilities,
    createNodeDatabasePlatform,
    nodeProcessPlatform,
    nodeServerPlatform,
} from '@xscs/core/node';

import { runBootstrap } from './src/bootstrap';

const database = await createNodeDatabasePlatform();
assertNodeSqliteCapabilities(database);
configureDatabasePlatform(database);
configureProcessPlatform(nodeProcessPlatform);
configureServerPlatform(nodeServerPlatform);
await runBootstrap(process.argv.slice(2));

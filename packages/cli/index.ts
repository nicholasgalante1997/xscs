#!/usr/bin/env bun

import { configureDatabasePlatform, configureProcessPlatform, configureServerPlatform } from '@xscs/core';
import { bunDatabasePlatform, bunProcessPlatform, bunServerPlatform } from '@xscs/core/bun';

import { runBootstrap } from './src/bootstrap';

configureDatabasePlatform(bunDatabasePlatform);
configureProcessPlatform(bunProcessPlatform);
configureServerPlatform(bunServerPlatform);
await runBootstrap(process.argv.slice(2));

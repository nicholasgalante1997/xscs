#!/usr/bin/env bun

import { configureDatabasePlatform } from '@xscs/core';
import { bunDatabasePlatform } from '@xscs/core/bun';

import { runBootstrap } from './src/bootstrap';

configureDatabasePlatform(bunDatabasePlatform);
await runBootstrap(process.argv.slice(2));

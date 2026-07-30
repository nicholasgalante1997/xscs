import { resolve } from 'node:path';

import {
    type DB,
    ensureWorkspace,
    openStore,
    type Workspace,
} from '@xscs/core';

import { type CommandInput, flagBool, flagString } from '../command-input';
import { currentBranch } from '../git';

export interface CommandContext {
    db: DB;
    workspace: Workspace;
    branch: string | null;
    json: boolean;
}

export function makeCommandContext(input: CommandInput): CommandContext {
    const db = openStore();
    const cwd = resolve(flagString(input, 'cwd') ?? process.cwd());
    const workspace = ensureWorkspace(db, cwd);
    return {
        db,
        workspace,
        branch: currentBranch(workspace.root),
        json: flagBool(input, 'json'),
    };
}

export function writeCommandOutput(context: CommandContext, human: string, data: unknown): void {
    if (context.json) console.log(JSON.stringify(data, null, 2));
    else console.log(human);
}

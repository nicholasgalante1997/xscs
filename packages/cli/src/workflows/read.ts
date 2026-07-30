import {
    buildBrief,
    type ItemStatus,
    type ItemType,
    listItems,
    renderHandoff,
    searchItems,
} from '@xscs/core';

import {
    type CommandInput,
    flagBool,
    flagList,
    flagNumber,
    flagString,
} from '../command-input';
import { makeCommandContext, writeCommandOutput } from './context';
import { formatItem } from './format';

export function cmdBrief(input: CommandInput): void {
    const context = makeCommandContext(input);
    const brief = buildBrief(context.db, {
        workspace_id: context.workspace.id,
        branch: context.branch,
        query: flagString(input, 'query') ?? (input.positionals.join(' ') || null),
        budgetTokens: flagNumber(input, 'budget') ?? 1200,
        reason: 'manual',
        workspaceName: context.workspace.name,
    });
    writeCommandOutput(context, brief.text || '(no durable context stored for this workspace yet)', brief);
}

export function cmdHandoff(input: CommandInput): void {
    const context = makeCommandContext(input);
    const text = renderHandoff(context.db, context.workspace, {
        branch: context.branch,
        write: !flagBool(input, 'stdout'),
        budgetTokens: flagNumber(input, 'budget'),
    });
    writeCommandOutput(context, text, { text });
}

export function cmdSearch(input: CommandInput): void {
    const context = makeCommandContext(input);
    const query = input.positionals.join(' ') || flagString(input, 'query') || '';
    const hits = searchItems(context.db, query, {
        workspace_id: context.workspace.id,
        limit: flagNumber(input, 'limit') ?? 15,
    });
    writeCommandOutput(
        context,
        hits.length ? hits.map((hit) => formatItem(hit.item, hit.relevance)).join('\n\n') : '(no matches)',
        hits,
    );
}

export function cmdList(input: CommandInput): void {
    const context = makeCommandContext(input);
    const statuses = flagList(input, 'status') as ItemStatus[];
    const types = flagList(input, 'type') as ItemType[];
    const items = listItems(context.db, {
        workspace_id: context.workspace.id,
        status: statuses.length ? statuses : ['active'],
        type: types.length ? types : undefined,
        limit: flagNumber(input, 'limit') ?? 60,
    });
    writeCommandOutput(
        context,
        items.length ? items.map((item) => formatItem(item)).join('\n\n') : '(nothing stored)',
        items,
    );
}

export function cmdExport(input: CommandInput): void {
    const context = makeCommandContext(input);
    const all = flagBool(input, 'all');
    const items = listItems(context.db, {
        workspace_id: all ? null : context.workspace.id,
        status: ['active', 'proposed', 'archived', 'superseded'],
        limit: 10_000,
    });
    console.log(JSON.stringify({ version: 1, exported_at: Date.now(), items }, null, 2));
}

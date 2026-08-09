import {
    buildBrief,
    listItems,
    renderHandoff,
    searchItems,
} from '@xscs/core';

import { makeCommandContext, writeCommandOutput } from './context';
import { formatItem } from './format';
import type {
    AllInput,
    HandoffInput,
    ListInput,
    QueryInput,
} from './input';

export function cmdBrief(input: QueryInput): void {
    const context = makeCommandContext(input);
    const brief = buildBrief(context.db, {
        workspace_id: context.workspace.id,
        branch: context.branch,
        query: input.query.join(' ') || null,
        budgetTokens: input.budget ?? 1200,
        reason: 'manual',
        workspaceName: context.workspace.name,
    });
    writeCommandOutput(context, brief.text || '(no durable context stored for this workspace yet)', brief);
}

export function cmdHandoff(input: HandoffInput): void {
    const context = makeCommandContext(input);
    const text = renderHandoff(context.db, context.workspace, {
        branch: context.branch,
        write: !input.stdout,
        budgetTokens: input.budget,
    });
    writeCommandOutput(context, text, { text });
}

export function cmdSearch(input: QueryInput): void {
    const context = makeCommandContext(input);
    const query = input.query.join(' ');
    const hits = searchItems(context.db, query, {
        workspace_id: context.workspace.id,
        limit: input.limit ?? 15,
    });
    writeCommandOutput(
        context,
        hits.length ? hits.map((hit) => formatItem(hit.item, hit.relevance)).join('\n\n') : '(no matches)',
        hits,
    );
}

export function cmdList(input: ListInput): void {
    const context = makeCommandContext(input);
    const items = listItems(context.db, {
        workspace_id: context.workspace.id,
        status: input.statuses.length ? input.statuses : ['active'],
        type: input.types.length ? input.types : undefined,
        limit: input.limit ?? 60,
    });
    writeCommandOutput(
        context,
        items.length ? items.map((item) => formatItem(item)).join('\n\n') : '(nothing stored)',
        items,
    );
}

export function cmdExport(input: AllInput): void {
    const context = makeCommandContext(input);
    const items = listItems(context.db, {
        workspace_id: input.all ? null : context.workspace.id,
        status: ['active', 'proposed', 'archived', 'superseded'],
        limit: 10_000,
    });
    console.log(JSON.stringify({ version: 1, exported_at: Date.now(), items }, null, 2));
}

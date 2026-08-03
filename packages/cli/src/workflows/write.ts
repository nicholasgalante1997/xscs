import {
    deleteItem,
    getItem,
    listItems,
    putItem,
    setItemPinned,
    setItemScope,
    setItemStatus,
} from '@xscs/core';

import { UsageError } from '../errors';
import { makeCommandContext, writeCommandOutput } from './context';
import { formatItem } from './format';
import type {
    ItemIdsInput,
    PromoteInput,
    RememberInput,
    ReviewInput,
} from './input';

export function cmdRemember(input: RememberInput): void {
    const context = makeCommandContext(input);
    const title = input.title ?? input.positionalTitle.join(' ');
    const body = input.body ?? title;
    if (!title) {
        throw new UsageError('usage: xscs remember --type <type> --title "..." [--body "..."] [--why "..."] [--pin]');
    }
    const scope = input.scope;
    const result = putItem(context.db, {
        type: input.type ?? 'fact',
        title,
        body,
        why: input.why ?? null,
        scope: scope === 'global' || scope === 'branch' || scope === 'session' ? scope : 'workspace',
        scope_key: scope === 'branch' ? context.branch : null,
        tags: input.tags,
        confidence: input.confidence ?? 0.7,
        pinned: input.pin,
        status: 'active',
        source: 'manual',
        workspace_id: context.workspace.id,
    });
    writeCommandOutput(
        context,
        `${result.created ? 'stored' : 'reinforced'} ${result.item.id}\n${formatItem(result.item)}`,
        result,
    );
}

export function cmdReview(input: ReviewInput): void {
    const context = makeCommandContext(input);
    const { accept, reject } = input;

    if (accept.length || reject.length) {
        for (const id of accept) setItemStatus(context.db, id, 'active');
        for (const id of reject) setItemStatus(context.db, id, 'rejected');
        writeCommandOutput(context, `accepted ${accept.length}, rejected ${reject.length}`, { accept, reject });
        return;
    }

    if (input.acceptAll) {
        const proposed = listItems(context.db, {
            workspace_id: context.workspace.id,
            status: 'proposed',
            limit: 500,
        });
        for (const item of proposed) setItemStatus(context.db, item.id, 'active');
        writeCommandOutput(context, `accepted ${proposed.length} proposed items`, proposed);
        return;
    }

    const proposed = listItems(context.db, {
        workspace_id: context.workspace.id,
        status: 'proposed',
        limit: 100,
    });
    writeCommandOutput(
        context,
        proposed.length
            ? [
                  `${proposed.length} item(s) awaiting review for ${context.workspace.name}:\n`,
                  proposed.map((item) => formatItem(item)).join('\n\n'),
                  '\naccept: xscs review --accept <id> [--accept <id>]',
                  'reject: xscs review --reject <id>',
                  'or open the dashboard: xscs serve',
              ].join('\n')
            : '(review queue is empty)',
        proposed,
    );
}

export function cmdPin(input: ItemIdsInput, pinned: boolean): void {
    const context = makeCommandContext(input);
    const { ids } = input;
    for (const id of ids) setItemPinned(context.db, id, pinned);
    writeCommandOutput(context, `${pinned ? 'pinned' : 'unpinned'} ${ids.length} item(s)`, { ids, pinned });
}

export function cmdForget(input: ItemIdsInput): void {
    const context = makeCommandContext(input);
    const removed: string[] = [];
    for (const id of input.ids) {
        if (!getItem(context.db, id)) continue;
        deleteItem(context.db, id);
        removed.push(id);
    }
    writeCommandOutput(context, `deleted ${removed.length} item(s)`, removed);
}

export function cmdPromote(input: PromoteInput): void {
    const context = makeCommandContext(input);
    const { scope } = input;
    if (scope !== 'global' && scope !== 'workspace' && scope !== 'branch') {
        throw new UsageError('scope must be global, workspace or branch');
    }
    for (const id of input.ids) {
        setItemScope(context.db, id, scope, scope === 'branch' ? context.branch : null);
    }
    writeCommandOutput(context, `moved ${input.ids.length} item(s) to ${scope} scope`, {
        ids: input.ids,
        scope,
    });
}

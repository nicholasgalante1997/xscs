import {
    deleteItem,
    getItem,
    type ItemType,
    listItems,
    putItem,
    setItemPinned,
    setItemScope,
    setItemStatus,
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

export function cmdRemember(input: CommandInput): void {
    const context = makeCommandContext(input);
    const title = flagString(input, 'title') ?? input.positionals.join(' ');
    const body = flagString(input, 'body') ?? title;
    if (!title) {
        console.error('usage: xscs remember --type <type> --title "..." [--body "..."] [--why "..."] [--pin]');
        process.exitCode = 1;
        return;
    }
    const scope = flagString(input, 'scope');
    const result = putItem(context.db, {
        type: (flagString(input, 'type') ?? 'fact') as ItemType,
        title,
        body,
        why: flagString(input, 'why') ?? null,
        scope: scope === 'global' || scope === 'branch' || scope === 'session' ? scope : 'workspace',
        scope_key: scope === 'branch' ? context.branch : null,
        tags: flagList(input, 'tag'),
        confidence: flagNumber(input, 'confidence') ?? 0.7,
        pinned: flagBool(input, 'pin'),
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

export function cmdReview(input: CommandInput): void {
    const context = makeCommandContext(input);
    const accept = flagList(input, 'accept');
    const reject = flagList(input, 'reject');

    if (accept.length || reject.length) {
        for (const id of accept) setItemStatus(context.db, id, 'active');
        for (const id of reject) setItemStatus(context.db, id, 'rejected');
        writeCommandOutput(context, `accepted ${accept.length}, rejected ${reject.length}`, { accept, reject });
        return;
    }

    if (flagBool(input, 'accept-all')) {
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

export function cmdPin(input: CommandInput, pinned: boolean): void {
    const context = makeCommandContext(input);
    const ids = input.positionals;
    for (const id of ids) setItemPinned(context.db, id, pinned);
    writeCommandOutput(context, `${pinned ? 'pinned' : 'unpinned'} ${ids.length} item(s)`, { ids, pinned });
}

export function cmdForget(input: CommandInput): void {
    const context = makeCommandContext(input);
    const removed: string[] = [];
    for (const id of input.positionals) {
        if (!getItem(context.db, id)) continue;
        deleteItem(context.db, id);
        removed.push(id);
    }
    writeCommandOutput(context, `deleted ${removed.length} item(s)`, removed);
}

export function cmdPromote(input: CommandInput): void {
    const context = makeCommandContext(input);
    const scope = flagString(input, 'scope') ?? 'global';
    if (scope !== 'global' && scope !== 'workspace' && scope !== 'branch') {
        console.error('scope must be global, workspace or branch');
        process.exitCode = 1;
        return;
    }
    for (const id of input.positionals) {
        setItemScope(context.db, id, scope, scope === 'branch' ? context.branch : null);
    }
    writeCommandOutput(context, `moved ${input.positionals.length} item(s) to ${scope} scope`, {
        ids: input.positionals,
        scope,
    });
}

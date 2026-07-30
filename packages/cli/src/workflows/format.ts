import type { Item } from '@xscs/core';

export function formatItem(item: Item, relevance?: number): string {
    const flags = [
        item.pinned ? 'pinned' : null,
        item.status !== 'active' ? item.status : null,
        item.scope !== 'workspace' ? item.scope : null,
        relevance !== undefined ? `rel ${relevance.toFixed(2)}` : null,
    ].filter(Boolean);
    return [
        `${item.id}  [${item.type}] ${item.title}`,
        `  ${item.body.replace(/\n/g, '\n  ')}`,
        item.why ? `  why: ${item.why}` : null,
        `  conf ${item.confidence.toFixed(2)}  used ${item.use_count}×  src ${item.source}${flags.length ? '  ' + flags.join(' ') : ''}`,
    ]
        .filter(Boolean)
        .join('\n');
}

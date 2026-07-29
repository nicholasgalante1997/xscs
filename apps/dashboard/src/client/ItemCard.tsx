import type { Item } from '@xscs/core';
import type { ReactElement } from 'react';

import type { ItemAction } from '../types';

export interface ItemCardProps {
    item: Item;
    selected?: boolean;
    onToggle?: (id: string) => void;
    onAction: (ids: string[], action: ItemAction) => void;
    /** Review mode leads with accept/reject; library mode leads with pin/archive. */
    mode: 'review' | 'library' | 'archive';
}

export function ItemCard({ item, selected, onToggle, onAction, mode }: ItemCardProps): ReactElement {
    const age = relativeTime(item.updated_at);
    return (
        <article className={`card${selected ? ' selected' : ''}`}>
            <header>
                {onToggle ? (
                    <input
                        type="checkbox"
                        checked={!!selected}
                        onChange={() => onToggle(item.id)}
                        aria-label={`select ${item.title}`}
                    />
                ) : null}
                <h3>{item.title}</h3>
                <span className="tag type">{item.type}</span>
                {item.pinned ? <span className="tag pinned">pinned</span> : null}
                {item.scope !== 'workspace' ? <span className="tag">{item.scope}</span> : null}
            </header>

            <p>{item.body}</p>
            {item.why ? <p className="why">{item.why}</p> : null}

            <footer>
                <span className="meta">
                    {item.id} · conf {item.confidence.toFixed(2)} · used {item.use_count}× · {item.source} · {age}
                </span>
                <span className="grow" />
                {mode === 'review' ? (
                    <>
                        <button className="act primary" onClick={() => onAction([item.id], 'accept')}>
                            accept
                        </button>
                        <button className="act danger" onClick={() => onAction([item.id], 'reject')}>
                            reject
                        </button>
                    </>
                ) : null}
                {mode === 'library' ? (
                    <>
                        <button className="act" onClick={() => onAction([item.id], item.pinned ? 'unpin' : 'pin')}>
                            {item.pinned ? 'unpin' : 'pin'}
                        </button>
                        <button className="act" onClick={() => onAction([item.id], item.scope === 'global' ? 'demote' : 'promote')}>
                            {item.scope === 'global' ? 'scope to workspace' : 'make global'}
                        </button>
                        <button className="act" onClick={() => onAction([item.id], 'archive')}>
                            archive
                        </button>
                    </>
                ) : null}
                {mode === 'archive' ? (
                    <button className="act" onClick={() => onAction([item.id], 'restore')}>
                        restore
                    </button>
                ) : null}
                <button className="act danger" onClick={() => onAction([item.id], 'forget')}>
                    delete
                </button>
            </footer>
        </article>
    );
}

export function relativeTime(ts: number, now = Date.now()): string {
    const diff = Math.max(0, now - ts);
    const minutes = Math.round(diff / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.round(days / 30)}mo ago`;
}

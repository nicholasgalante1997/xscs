import type { Item } from '@xscs/core';

import type { DashboardState, ItemAction } from '../types';

async function json<T>(input: string, init?: RequestInit): Promise<T> {
    const res = await fetch(input, init);
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${input} → ${res.status}`);
    return (await res.json()) as T;
}

export function fetchState(workspace: string | null): Promise<DashboardState> {
    const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    return json<DashboardState>(`/api/state${q}`);
}

export function searchItems(workspace: string | null, query: string): Promise<Item[]> {
    const params = new URLSearchParams({ q: query });
    if (workspace) params.set('workspace', workspace);
    return json<Item[]>(`/api/search?${params.toString()}`);
}

export function runAction(ids: string[], action: ItemAction): Promise<{ changed: number }> {
    return json<{ changed: number }>('/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, action }),
    });
}

export function resolveConflict(keep: string, drop: string, mode: 'supersede' | 'dismiss'): Promise<{ ok: boolean }> {
    return json<{ ok: boolean }>('/api/conflict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keep, drop, mode }),
    });
}

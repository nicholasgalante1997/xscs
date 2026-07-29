import {
    buildBrief,
    type DB,
    deleteItem,
    dismissDrift,
    findDriftCandidates,
    findWorkspaceByRootOrName,
    type Item,
    listItems,
    listWorkspaces,
    recentSessions,
    searchItems,
    setItemPinned,
    setItemScope,
    setItemStatus,
    stats,
    storePath,
    supersede,
    type Workspace,
} from '@xscs/core';

import type { ActionRequest, DashboardState, ItemAction } from './types';

export function loadState(db: DB, workspaceKey: string | null, branch: string | null): DashboardState {
    const workspaces = listWorkspaces(db);
    const workspace: Workspace | null = workspaceKey
        ? findWorkspaceByRootOrName(db, workspaceKey)
        : (workspaces[0] ?? null);
    const wsId = workspace?.id ?? null;

    return {
        workspaces: workspaces.map((w) => {
            const s = stats(db, w.id);
            return { ...w, active_items: s.active_items, sessions: s.sessions };
        }),
        workspace,
        stats: stats(db, wsId),
        proposed: wsId ? listItems(db, { workspace_id: wsId, status: 'proposed', limit: 200 }) : [],
        active: wsId ? listItems(db, { workspace_id: wsId, status: 'active', limit: 400 }) : [],
        archived: wsId ? listItems(db, { workspace_id: wsId, status: ['archived', 'superseded', 'rejected'], limit: 200 }) : [],
        sessions: recentSessions(db, wsId, 30),
        conflicts: wsId ? findDriftCandidates(db, wsId, 25) : [],
        brief: wsId
            ? buildBrief(db, {
                  workspace_id: wsId,
                  branch,
                  budgetTokens: 1200,
                  reason: 'dashboard preview',
                  workspaceName: workspace?.name,
              })
            : { text: '', tokens: 0, item_ids: [], dropped: 0 },
        branch,
        storePath: storePath(),
    };
}

/**
 * Every mutation the dashboard can perform, in one place. Bulk by design — the
 * review queue is only usable if you can clear ten items in one gesture.
 */
export function applyAction(db: DB, req: ActionRequest, branch: string | null): { changed: number } {
    let changed = 0;
    for (const id of req.ids) {
        if (act(db, id, req.action, branch)) changed++;
    }
    return { changed };
}

function act(db: DB, id: string, action: ItemAction, branch: string | null): boolean {
    switch (action) {
        case 'accept':
            setItemStatus(db, id, 'active');
            return true;
        case 'reject':
            setItemStatus(db, id, 'rejected');
            return true;
        case 'archive':
            setItemStatus(db, id, 'archived');
            return true;
        case 'restore':
            setItemStatus(db, id, 'active');
            return true;
        case 'pin':
            setItemPinned(db, id, true);
            return true;
        case 'unpin':
            setItemPinned(db, id, false);
            return true;
        case 'forget':
            deleteItem(db, id);
            return true;
        case 'promote':
            setItemScope(db, id, 'global', null);
            return true;
        case 'demote':
            setItemScope(db, id, branch ? 'branch' : 'workspace', branch);
            return true;
        default:
            return false;
    }
}

export function resolveConflict(db: DB, keepId: string, dropId: string, mode: 'supersede' | 'dismiss'): void {
    if (mode === 'dismiss') {
        dismissDrift(db, keepId, dropId);
        return;
    }
    supersede(db, dropId, keepId);
}

export function search(db: DB, query: string, workspaceId: string | null): Item[] {
    if (!query.trim()) return [];
    return searchItems(db, query, { workspace_id: workspaceId, limit: 40 }).map((h) => h.item);
}

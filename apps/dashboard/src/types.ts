import type { Item, Session, StoreStats, Workspace } from '@xscs/core';

export interface DriftPair {
    kind: 'duplicate' | 'contradiction';
    overlap: number;
    hint: string;
    a: Item;
    b: Item;
}

export interface DashboardState {
    workspaces: Array<Workspace & { active_items: number; sessions: number }>;
    workspace: Workspace | null;
    stats: StoreStats;
    proposed: Item[];
    active: Item[];
    archived: Item[];
    sessions: Session[];
    conflicts: DriftPair[];
    brief: { text: string; tokens: number; item_ids: string[]; dropped: number };
    branch: string | null;
    storePath: string;
}

export type ItemAction = 'accept' | 'reject' | 'pin' | 'unpin' | 'archive' | 'restore' | 'forget' | 'promote' | 'demote';

export interface ActionRequest {
    ids: string[];
    action: ItemAction;
}

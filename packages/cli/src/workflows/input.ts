import type {
    DistillerBackend,
    ItemScope,
    ItemStatus,
    ItemType,
} from '@xscs/core';

export interface ContextInput {
    cwd?: string;
    json: boolean;
}

export interface InitInput extends ContextInput {
    user: boolean;
    claude: boolean;
    codex: boolean;
    kiro: boolean;
    withMcp: boolean;
    dryRun: boolean;
}

export interface AllInput extends ContextInput {
    all: boolean;
}

export interface QueryInput extends ContextInput {
    query: string[];
    budget?: number;
    limit?: number;
}

export interface HandoffInput extends ContextInput {
    stdout: boolean;
    budget?: number;
}

export interface ListInput extends ContextInput {
    statuses: ItemStatus[];
    types: ItemType[];
    limit?: number;
}

export interface RememberInput extends ContextInput {
    positionalTitle: string[];
    type?: ItemType;
    title?: string;
    body?: string;
    why?: string;
    pin: boolean;
    scope?: ItemScope;
    tags: string[];
    confidence?: number;
}

export interface ReviewInput extends ContextInput {
    accept: string[];
    reject: string[];
    acceptAll: boolean;
}

export interface ItemIdsInput extends ContextInput {
    ids: string[];
}

export interface PromoteInput extends ItemIdsInput {
    scope: string;
}

export interface DistillInput extends ContextInput {
    session?: string;
    mode?: string;
    backend?: DistillerBackend;
    limit?: number;
    dryRun: boolean;
    handoff: boolean;
    quiet: boolean;
}

export interface ConflictsInput extends ContextInput {
    dismiss: string[];
    limit?: number;
}

export interface PruneInput extends ContextInput {
    eventsDays?: number;
    briefsDays?: number;
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { bunDatabasePlatform } from '../bun';
import { configureDatabasePlatform, type DB, openStore } from './db';
import { decay } from './decay';
import { findDriftCandidates, jaccard, tokens } from './drift';
import { buildBrief, rankItems } from './recall';
import type { ItemDraft } from './schema';
import { ensureWorkspace, listItems, putItem } from './store';

let db: DB;
let ws: string;

const DAY = 86_400_000;

configureDatabasePlatform(bunDatabasePlatform);

beforeEach(() => {
    db = openStore({ path: ':memory:', fresh: true });
    ws = ensureWorkspace(db, process.cwd()).id;
});

afterEach(() => db.close());

function add(draft: Partial<ItemDraft> & { title: string }): string {
    return putItem(db, {
        type: 'fact',
        body: draft.title + ' body text',
        source: 'test',
        workspace_id: ws,
        ...draft,
    }).item.id;
}

function age(id: string, days: number): void {
    const ts = Date.now() - days * DAY;
    db.query('UPDATE items SET created_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id);
}

describe('ranking', () => {
    test('pinned items outrank fresh unpinned ones', () => {
        const pinned = add({ title: 'Pinned rule about deployments', pinned: true, type: 'preference' });
        add({ title: 'Some recent unpinned fact' });
        const ranked = rankItems(db, { workspace_id: ws });
        expect(ranked[0]!.item.id).toBe(pinned);
    });

    test('constraints outrank glossary entries at equal age and confidence', () => {
        const constraint = add({ title: 'Never force push to main', type: 'constraint' });
        add({ title: 'Void is the design system name', type: 'glossary' });
        const ranked = rankItems(db, { workspace_id: ws });
        expect(ranked[0]!.item.id).toBe(constraint);
    });

    test('branch-scoped items are excluded from other branches', () => {
        add({ title: 'Migration half-applied on this branch', scope: 'branch', scope_key: 'feat/x', type: 'open_thread' });
        expect(rankItems(db, { workspace_id: ws, branch: 'main' })).toHaveLength(0);
        expect(rankItems(db, { workspace_id: ws, branch: 'feat/x' })).toHaveLength(1);
    });

    test('session-scoped items never cross a session boundary', () => {
        add({ title: 'Temporary note for this session only', scope: 'session', scope_key: 'ses_1' });
        expect(rankItems(db, { workspace_id: ws })).toHaveLength(0);
    });

    test('a query biases ranking toward matching items', () => {
        add({ title: 'Deployment uses turbo and bun build' });
        const target = add({ title: 'Authentication tokens rotate every 24 hours' });
        const ranked = rankItems(db, { workspace_id: ws, query: 'how does authentication rotate tokens' });
        expect(ranked[0]!.item.id).toBe(target);
        expect(ranked[0]!.reasons).toContain('query-match');
    });

    test('old never-used items are penalised as stale', () => {
        const old = add({ title: 'A fact nobody ever used again' });
        age(old, 90);
        const ranked = rankItems(db, { workspace_id: ws });
        expect(ranked[0]!.reasons).toContain('stale');
    });
});

describe('brief', () => {
    test('the token budget covers the whole brief, framing included', () => {
        for (let i = 0; i < 60; i++) {
            add({ title: `Fact number ${i} about the system`, body: 'x'.repeat(400) });
        }
        for (const budget of [200, 300, 600, 1200]) {
            const brief = buildBrief(db, { workspace_id: ws, budgetTokens: budget });
            expect(brief.tokens).toBeLessThanOrEqual(budget);
        }
        const brief = buildBrief(db, { workspace_id: ws, budgetTokens: 300 });
        expect(brief.dropped).toBeGreaterThan(0);
        expect(brief.item_ids.length).toBeGreaterThan(0);
    });

    test('a budget too small for any item yields an empty brief, not an over-budget one', () => {
        add({ title: 'A fact with a long body', body: 'y'.repeat(2000) });
        const brief = buildBrief(db, { workspace_id: ws, budgetTokens: 60 });
        expect(brief.tokens).toBeLessThanOrEqual(60);
    });

    test('an unresolved workspace recalls globals only, never other repositories', () => {
        add({ title: 'A workspace-local secret about this repo' });
        add({ title: 'A rule that applies everywhere', scope: 'global', type: 'preference' });
        const ranked = rankItems(db, { workspace_id: null });
        expect(ranked).toHaveLength(1);
        expect(ranked[0]!.item.scope).toBe('global');
    });

    test('per-type quotas stop one type from flooding the brief', () => {
        for (let i = 0; i < 40; i++) add({ title: `Trivia entry ${i}`, type: 'glossary' });
        const brief = buildBrief(db, { workspace_id: ws, budgetTokens: 8000 });
        expect(brief.item_ids.length).toBeLessThanOrEqual(5);
    });

    test('an empty store produces an empty brief, not a stub header', () => {
        expect(buildBrief(db, { workspace_id: ws }).text).toBe('');
    });

    test('the brief frames memories as priors, not instructions', () => {
        add({ title: 'Never run migrations against prod', type: 'constraint' });
        const brief = buildBrief(db, { workspace_id: ws, workspaceName: 'demo' });
        expect(brief.text).toContain('not instructions for this turn');
        expect(brief.text).toContain('Never run migrations against prod');
    });
});

describe('decay', () => {
    test('erodes idle items and archives the worthless ones', () => {
        const idle = add({ title: 'Idle fact that nobody used', confidence: 0.16 });
        age(idle, 60);
        const report = decay(db, { force: true });
        expect(report.ran).toBe(true);
        expect(report.decayed).toBeGreaterThan(0);
        const remaining = listItems(db, { workspace_id: ws, status: 'active' });
        expect(remaining.find((i) => i.id === idle)).toBeUndefined();
    });

    test('pinned items are exempt', () => {
        const pinned = add({ title: 'Pinned and ancient', pinned: true, confidence: 0.05 });
        age(pinned, 200);
        decay(db, { force: true });
        expect(listItems(db, { workspace_id: ws, status: 'active' }).map((i) => i.id)).toContain(pinned);
    });

    test('rate-limits itself unless forced', () => {
        decay(db, { force: true });
        expect(decay(db).ran).toBe(false);
    });

    test('stale open threads are archived', () => {
        const thread = add({ title: 'Finish the migration', type: 'open_thread' });
        age(thread, 40);
        const report = decay(db, { force: true });
        expect(report.staleThreads).toBeGreaterThan(0);
    });
});

describe('drift', () => {
    test('flags opposite-polarity claims about the same thing', () => {
        add({ title: 'Always run bun test before committing', type: 'constraint' });
        add({ title: 'Never run bun test before committing', type: 'constraint' });
        const candidates = findDriftCandidates(db, ws);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0]!.kind).toBe('contradiction');
    });

    test('unrelated items are not flagged', () => {
        add({ title: 'The API lives in packages/api', type: 'fact' });
        add({ title: 'Design tokens are built with style dictionary', type: 'fact' });
        expect(findDriftCandidates(db, ws)).toHaveLength(0);
    });

    test('jaccard is symmetric and bounded', () => {
        const a = tokens('alpha beta gamma');
        const b = tokens('beta gamma delta');
        expect(jaccard(a, b)).toBeCloseTo(jaccard(b, a));
        expect(jaccard(a, a)).toBe(1);
        expect(jaccard(a, tokens(''))).toBe(0);
    });
});

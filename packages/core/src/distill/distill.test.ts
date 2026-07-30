import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { bunDatabasePlatform } from '../../bun';
import { configureDatabasePlatform, type DB, openStore } from '../db';
import { ensureWorkspace, getSession, listItems, upsertSession } from '../store';
import { distillSession } from './index';

let db: DB;

configureDatabasePlatform(bunDatabasePlatform);

beforeEach(() => {
    db = openStore({ path: ':memory:', fresh: true });
});

afterEach(() => db.close());

function session(harnessId = 's1') {
    const ws = ensureWorkspace(db, process.cwd());
    return upsertSession(db, {
        agent: 'claude',
        harness_session_id: harnessId,
        workspace_id: ws.id,
        cwd: process.cwd(),
    });
}

function addPrompt(sessionId: string, workspaceId: string, prompt: string): void {
    db.query('INSERT INTO events (session_id, workspace_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?)').run(
        sessionId,
        workspaceId,
        Date.now(),
        'prompt',
        JSON.stringify({ prompt }),
    );
}

describe('distillation lease', () => {
    test('a second run on the same session is a no-op', async () => {
        const s = session();
        addPrompt(s.id, s.workspace_id, 'Never push directly to main.');

        const first = await distillSession(db, s);
        expect(first.skipped).toBeUndefined();
        expect(first.created).toBe(1);

        // Both SessionEnd and the next SessionStart kick a distiller; the loser
        // must not write a duplicate set of items.
        const second = await distillSession(db, getSession(db, s.id)!);
        expect(second.skipped).toBe(true);
        expect(second.created).toBe(0);
        expect(listItems(db, { workspace_id: s.workspace_id, status: 'active' })).toHaveLength(1);
    });

    test('a dry run neither claims nor writes', async () => {
        const s = session();
        addPrompt(s.id, s.workspace_id, 'Always run the typecheck before pushing.');

        const dry = await distillSession(db, s, { dryRun: true });
        expect(dry.drafts.length).toBeGreaterThan(0);
        expect(dry.created).toBe(0);
        expect(getSession(db, s.id)!.distilled_at).toBeNull();

        const real = await distillSession(db, s);
        expect(real.created).toBeGreaterThan(0);
    });

    test('marks its events consumed so they can be pruned later', async () => {
        const s = session();
        addPrompt(s.id, s.workspace_id, 'Never commit generated files.');
        await distillSession(db, s);
        const unconsumed = db
            .query<{ c: number }, [string]>('SELECT count(*) AS c FROM events WHERE session_id = ? AND consumed_at IS NULL')
            .get(s.id);
        expect(unconsumed!.c).toBe(0);
    });
});

import type { DB } from './db';
import { setSetting, tryClaimInterval } from './store';

const DAY = 86_400_000;

export interface DecayOptions {
    /** Items untouched for this long start losing confidence. */
    idleDays?: number;
    /** Multiplier applied per decay run to idle items. */
    factor?: number;
    /** Below this confidence an unused item is archived rather than kept. */
    archiveBelow?: number;
    /** Open threads older than this are almost always stale. */
    openThreadStaleDays?: number;
    /** Don't run more than once per interval, regardless of how often it is called. */
    minIntervalMs?: number;
    force?: boolean;
    now?: number;
}

export interface DecayReport {
    ran: boolean;
    decayed: number;
    archived: number;
    staleThreads: number;
}

/**
 * Forgetting is a feature. A store that only grows becomes a store nobody trusts,
 * and an untrusted store gets ignored — which is the same as not having one.
 *
 * Two forces act on every item: recall reinforces it (`touchItems` bumps
 * `use_count` and `last_used_at`), and time erodes it. Pinned items are exempt
 * because a human asserted them; superseded items are left alone because their
 * history is the point.
 */
export function decay(db: DB, opts: DecayOptions = {}): DecayReport {
    const now = opts.now ?? Date.now();
    const minInterval = opts.minIntervalMs ?? 12 * 3600_000;

    if (!opts.force && !tryClaimInterval(db, 'last_decay_at', minInterval, now)) {
        return { ran: false, decayed: 0, archived: 0, staleThreads: 0 };
    }

    const idleCutoff = now - (opts.idleDays ?? 30) * DAY;
    const factor = opts.factor ?? 0.9;
    const archiveBelow = opts.archiveBelow ?? 0.15;
    const threadCutoff = now - (opts.openThreadStaleDays ?? 21) * DAY;

    const decayed = db
        .query(
            `UPDATE items SET confidence = confidence * ?, updated_at = updated_at
             WHERE pinned = 0 AND status = 'active'
               AND coalesce(last_used_at, created_at) < ?`,
        )
        .run(factor, idleCutoff).changes;

    const archived = db
        .query(
            `UPDATE items SET status = 'archived', updated_at = ?
             WHERE pinned = 0 AND status = 'active' AND confidence < ?
               AND coalesce(last_used_at, created_at) < ?`,
        )
        .run(now, archiveBelow, idleCutoff).changes;

    // An open thread that nobody has picked up in three weeks is either done or
    // abandoned; either way, injecting it every session is noise. Age is measured
    // from the last sign of life, not from creation — a thread that is still being
    // recalled and re-derived is demonstrably still live.
    const staleThreads = db
        .query(
            `UPDATE items SET status = 'archived', updated_at = ?
             WHERE type = 'open_thread' AND pinned = 0 AND status = 'active'
               AND max(coalesce(last_used_at, 0), updated_at, created_at) < ?`,
        )
        .run(now, threadCutoff).changes;

    setSetting(db, 'last_decay_at', String(now));
    return { ran: true, decayed, archived, staleThreads };
}

/** Remove event rows that have been distilled and are older than the retention window. */
export function pruneEvents(db: DB, retentionDays = 60, now = Date.now()): number {
    const cutoff = now - retentionDays * DAY;
    return db.query('DELETE FROM events WHERE consumed_at IS NOT NULL AND ts < ?').run(cutoff).changes;
}

export function pruneBriefs(db: DB, retentionDays = 30, now = Date.now()): number {
    const cutoff = now - retentionDays * DAY;
    return db.query('DELETE FROM briefs WHERE created_at < ?').run(cutoff).changes;
}

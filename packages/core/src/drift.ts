import type { DB } from './db';
import type { Item } from './schema';
import { addLink, listItems, searchItems } from './store';

export interface DriftCandidate {
    a: Item;
    b: Item;
    overlap: number;
    kind: 'duplicate' | 'contradiction';
    hint: string;
}

const NEGATION = /\b(never|do ?n'?t|don't|avoid|must not|should not|no longer|without)\b/i;

/**
 * Memory drift is the production failure mode of every long-lived agent memory:
 * a lesson learned from one atypical session hardens into a general rule, and
 * later evidence that contradicts it accumulates alongside rather than replacing
 * it. The agent then sees both and picks arbitrarily.
 *
 * We cannot resolve contradictions automatically without an LLM call and a lot of
 * confidence we don't have. What we can do — cheaply, deterministically, and
 * every time the store is written — is *surface* the pairs a human should look
 * at: same type, high lexical overlap, different content. Duplicates get merged,
 * contradictions get superseded, and the decision stays with the person.
 */
export function findDriftCandidates(db: DB, workspace_id: string | null, limit = 40): DriftCandidate[] {
    const items = listItems(db, { workspace_id, status: 'active', limit: 400 });
    const byId = new Map(items.map((i) => [i.id, i]));
    const candidates: DriftCandidate[] = [];
    const seenPairs = reviewedPairs(db);

    for (const item of items) {
        // FTS narrows the comparison set from O(n²) to "things that share words".
        const hits = searchItems(db, item.title, { workspace_id, limit: 8 });
        for (const hit of hits) {
            const other = byId.get(hit.item.id);
            if (!other || other.id === item.id) continue;
            if (other.type !== item.type) continue;

            const pairKey = [item.id, other.id].sort().join('|');
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);

            const overlap = jaccard(tokens(item.title + ' ' + item.body), tokens(other.title + ' ' + other.body));
            if (overlap < 0.35) continue;

            const negatedA = NEGATION.test(item.title + ' ' + item.body);
            const negatedB = NEGATION.test(other.title + ' ' + other.body);
            const polarityFlip = negatedA !== negatedB;

            candidates.push({
                a: item,
                b: other,
                overlap,
                kind: polarityFlip ? 'contradiction' : overlap > 0.8 ? 'duplicate' : 'contradiction',
                hint: polarityFlip
                    ? 'These say similar things with opposite polarity — one probably supersedes the other.'
                    : overlap > 0.8
                      ? 'Near-identical wording — merge and keep the better-sourced one.'
                      : 'Overlapping claims — check whether the newer one replaces the older.',
            });
            if (candidates.length >= limit) return sortCandidates(candidates);
        }
    }
    return sortCandidates(candidates);
}

function sortCandidates(list: DriftCandidate[]): DriftCandidate[] {
    return list.sort((x, y) => {
        if (x.kind !== y.kind) return x.kind === 'contradiction' ? -1 : 1;
        return y.overlap - x.overlap;
    });
}

/** Record a reviewed pair so the dashboard stops re-suggesting it. */
export function dismissDrift(db: DB, aId: string, bId: string): void {
    addLink(db, aId, bId, 'reviewed', 'dismissed as not-a-conflict');
}

/** Pairs already judged by a human, seeded into the dedupe set so they never reappear. */
function reviewedPairs(db: DB): Set<string> {
    const rows = db
        .query<{ from_id: string; to_id: string }, []>(
            "SELECT from_id, to_id FROM links WHERE kind IN ('reviewed','supersedes')",
        )
        .all();
    return new Set(rows.map((r) => [r.from_id, r.to_id].sort().join('|')));
}

export function tokens(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9_./-]+/)
            .filter((t) => t.length > 2),
    );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
}

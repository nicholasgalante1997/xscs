import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read the current branch by parsing `.git/HEAD` rather than shelling out.
 * Spawning `git` costs 20-40ms and this runs on every hook invocation; reading
 * one small file costs microseconds and never blocks on an index lock.
 */
export function currentBranch(root: string): string | null {
    try {
        const headPath = join(root, '.git', 'HEAD');
        if (!existsSync(headPath)) return null;
        const head = readFileSync(headPath, 'utf8').trim();
        if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length);
        // Detached HEAD: the short sha is more useful than nothing.
        return head.slice(0, 8);
    } catch {
        return null;
    }
}

import {
    decay,
    dismissDrift,
    distillPending,
    distillSession,
    findDriftCandidates,
    getSession,
    pruneBriefs,
    pruneEvents,
    renderHandoff,
} from '@xscs/core';

import { makeCommandContext, writeCommandOutput } from './context';
import type {
    ConflictsInput,
    DistillInput,
    PruneInput,
} from './input';

export async function cmdDistill(input: DistillInput): Promise<void> {
    const context = makeCommandContext(input);
    const modeFlag = input.mode;
    const mode = modeFlag === 'agent' || modeFlag === 'both' ? modeFlag : 'heuristic';

    const sessionId = input.session;
    const reports = sessionId
        ? await (async () => {
              const session = getSession(context.db, sessionId);
              if (!session) return [];
              return [
                  await distillSession(context.db, session, {
                      mode,
                      dryRun: input.dryRun,
                      backend: input.backend,
                  }),
              ];
          })()
        : await distillPending(context.db, {
              mode,
              dryRun: input.dryRun,
              backend: input.backend,
              limit: input.limit ?? 10,
          });

    if (input.handoff) {
        try {
            renderHandoff(context.db, context.workspace, { branch: context.branch });
        } catch {
            /* handoff is best-effort */
        }
    }

    if (input.quiet && !context.json) return;

    const created = reports.reduce((count, report) => count + report.created, 0);
    const reinforced = reports.reduce((count, report) => count + report.reinforced, 0);
    const errors = reports.filter((report) => report.error);
    writeCommandOutput(
        context,
        [
            `distilled ${reports.length} session(s) in ${mode} mode${input.dryRun ? ' (dry run)' : ''}`,
            `  created:    ${created}`,
            `  reinforced: ${reinforced}`,
            ...(input.dryRun
                ? reports.flatMap((report) => report.drafts.map((draft) => `  · [${draft.type}] ${draft.title}`))
                : []),
            ...errors.map((error) => `  ! ${error.session_id}: ${error.error}`),
        ].join('\n'),
        reports,
    );
}

export function cmdConflicts(input: ConflictsInput): void {
    const context = makeCommandContext(input);
    const { dismiss } = input;
    if (dismiss.length === 2) {
        dismissDrift(context.db, dismiss[0]!, dismiss[1]!);
        writeCommandOutput(context, 'dismissed', dismiss);
        return;
    }
    const candidates = findDriftCandidates(context.db, context.workspace.id, input.limit ?? 20);
    writeCommandOutput(
        context,
        candidates.length
            ? candidates
                  .map(
                      (candidate) =>
                          `[${candidate.kind}] overlap ${(candidate.overlap * 100).toFixed(0)}% — ${candidate.hint}\n  A ${candidate.a.id}  ${candidate.a.title}\n  B ${candidate.b.id}  ${candidate.b.title}`,
                  )
                  .join('\n\n')
            : '(no conflicts detected)',
        candidates,
    );
}

export function cmdPrune(input: PruneInput): void {
    const context = makeCommandContext(input);
    const decayReport = decay(context.db, { force: true });
    const events = pruneEvents(context.db, input.eventsDays ?? 60);
    const briefs = pruneBriefs(context.db, input.briefsDays ?? 30);
    context.db.run('VACUUM');
    writeCommandOutput(
        context,
        [
            `decayed ${decayReport.decayed} item(s)`,
            `archived ${decayReport.archived} low-confidence item(s)`,
            `archived ${decayReport.staleThreads} stale open thread(s)`,
            `deleted ${events} consumed event(s), ${briefs} old brief(s)`,
        ].join('\n'),
        { decay: decayReport, events, briefs },
    );
}

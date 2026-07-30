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

import {
    type CommandInput,
    flagBool,
    flagList,
    flagNumber,
    flagString,
} from '../command-input';
import { makeCommandContext, writeCommandOutput } from './context';

export async function cmdDistill(input: CommandInput): Promise<void> {
    const context = makeCommandContext(input);
    const modeFlag = flagString(input, 'mode');
    const mode = modeFlag === 'agent' || modeFlag === 'both' ? modeFlag : 'heuristic';
    const dryRun = flagBool(input, 'dry-run');
    const quiet = flagBool(input, 'quiet');

    const sessionId = flagString(input, 'session');
    const reports = sessionId
        ? await (async () => {
              const session = getSession(context.db, sessionId);
              if (!session) return [];
              return [
                  await distillSession(context.db, session, {
                      mode,
                      dryRun,
                      backend: flagString(input, 'backend') as never,
                  }),
              ];
          })()
        : await distillPending(context.db, {
              mode,
              dryRun,
              limit: flagNumber(input, 'limit') ?? 10,
          });

    if (flagBool(input, 'handoff')) {
        try {
            renderHandoff(context.db, context.workspace, { branch: context.branch });
        } catch {
            /* handoff is best-effort */
        }
    }

    if (quiet && !context.json) return;

    const created = reports.reduce((count, report) => count + report.created, 0);
    const reinforced = reports.reduce((count, report) => count + report.reinforced, 0);
    const errors = reports.filter((report) => report.error);
    writeCommandOutput(
        context,
        [
            `distilled ${reports.length} session(s) in ${mode} mode${dryRun ? ' (dry run)' : ''}`,
            `  created:    ${created}`,
            `  reinforced: ${reinforced}`,
            ...(dryRun ? reports.flatMap((report) => report.drafts.map((draft) => `  · [${draft.type}] ${draft.title}`)) : []),
            ...errors.map((error) => `  ! ${error.session_id}: ${error.error}`),
        ].join('\n'),
        reports,
    );
}

export function cmdConflicts(input: CommandInput): void {
    const context = makeCommandContext(input);
    const dismiss = flagList(input, 'dismiss');
    if (dismiss.length === 2) {
        dismissDrift(context.db, dismiss[0]!, dismiss[1]!);
        writeCommandOutput(context, 'dismissed', dismiss);
        return;
    }
    const candidates = findDriftCandidates(context.db, context.workspace.id, flagNumber(input, 'limit') ?? 20);
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

export function cmdPrune(input: CommandInput): void {
    const context = makeCommandContext(input);
    const decayReport = decay(context.db, { force: true });
    const events = pruneEvents(context.db, flagNumber(input, 'events-days') ?? 60);
    const briefs = pruneBriefs(context.db, flagNumber(input, 'briefs-days') ?? 30);
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

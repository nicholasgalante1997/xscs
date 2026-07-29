#!/usr/bin/env bun
import { type AgentKind } from '@xscs/core';

import { type Args, flagBool, flagNumber, flagString, parseArgs } from './src/args';
import {
    cmdBrief,
    cmdConflicts,
    cmdDistill,
    cmdDoctor,
    cmdExport,
    cmdForget,
    cmdHandoff,
    cmdInit,
    cmdList,
    cmdPin,
    cmdPromote,
    cmdPrune,
    cmdRemember,
    cmdReview,
    cmdSearch,
    cmdStats,
    cmdWorkspaces,
} from './src/commands';
import { runHook } from './src/hook';
import { runMcpServer } from './src/mcp';

const HELP = `xscs — cross-session context store for coding agents

  Captures what happens in Claude Code and Codex sessions, distills the durable
  parts, and injects them back into the next cold context window.

usage: xscs <command> [options]

setup
  init [--user] [--claude] [--codex] [--no-mcp] [--dry-run]
                          wire hooks into this project (or your home dir with --user)
  doctor                  check store, hook wiring and harness availability
  mcp                     run the MCP server over stdio (registered by init)

reading
  brief [query] [--budget N]      render the context brief a fresh session would receive
  search <query> [--limit N]      keyword search over stored context
  list [--type t] [--status s]    list stored items
  open                            alias for: list --type open_thread
  handoff [--stdout]              write .xscs/HANDOFF.md
  stats [--all]                   store health
  workspaces                      every workspace this store knows about
  export [--all]                  dump items as JSON

writing
  remember --type <t> --title "..." [--body "..."] [--why "..."] [--pin] [--scope s]
  review [--accept id] [--reject id] [--accept-all]
                          triage items proposed by distillation
  pin <id...> / unpin <id...>
  promote <id...> [--scope global]
  forget <id...>

maintenance
  distill [--session id] [--pending] [--mode heuristic|agent|both] [--dry-run]
  conflicts [--dismiss idA --dismiss idB]
  prune [--events-days N] [--briefs-days N]

internal
  hook --event <Event> [--agent claude|codex]   read a hook payload on stdin

global flags: --json  --cwd <path>
env: XSCS_HOME, XSCS_DB, XSCS_DISTILLER=claude|codex|none
`;

async function main(): Promise<void> {
    const args: Args = parseArgs(process.argv.slice(2));

    switch (args.command) {
        case 'hook':
            await runHook({
                agent: flagString(args, 'agent') as AgentKind | undefined,
                event: flagString(args, 'event'),
                budget: flagNumber(args, 'budget'),
                noTopup: flagBool(args, 'no-topup'),
                noBackground: flagBool(args, 'no-background'),
            });
            return;
        case 'mcp':
            await runMcpServer();
            return;
        case 'init':
            cmdInit(args);
            return;
        case 'distill':
            await cmdDistill(args);
            return;
        case 'brief':
            cmdBrief(args);
            return;
        case 'handoff':
            cmdHandoff(args);
            return;
        case 'search':
            cmdSearch(args);
            return;
        case 'list':
            cmdList(args);
            return;
        case 'open':
            cmdList({ ...args, flags: { ...args.flags, type: 'open_thread' } });
            return;
        case 'remember':
            cmdRemember(args);
            return;
        case 'review':
            cmdReview(args);
            return;
        case 'pin':
            cmdPin(args, true);
            return;
        case 'unpin':
            cmdPin(args, false);
            return;
        case 'promote':
            cmdPromote(args);
            return;
        case 'forget':
            cmdForget(args);
            return;
        case 'conflicts':
            cmdConflicts(args);
            return;
        case 'prune':
            cmdPrune(args);
            return;
        case 'stats':
            cmdStats(args);
            return;
        case 'workspaces':
            cmdWorkspaces(args);
            return;
        case 'doctor':
            cmdDoctor(args);
            return;
        case 'export':
            cmdExport(args);
            return;
        case 'serve': {
            // Imported lazily: the dashboard pulls in React, and no hook should
            // ever pay that cost.
            const { serveDashboard } = await import('@xscs/dashboard');
            await serveDashboard({ port: flagNumber(args, 'port') ?? 4319, open: !flagBool(args, 'no-open') });
            return;
        }
        case 'help':
        case '--help':
        case '-h':
            console.log(HELP);
            return;
        default:
            console.error(`unknown command: ${args.command}\n`);
            console.log(HELP);
            process.exitCode = 1;
    }
}

await main();

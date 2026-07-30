import cac from 'cac';

import { registerMaintenanceCommands } from './registrations/maintenance';
import { registerReadCommands } from './registrations/read';
import { registerSetupCommands } from './registrations/setup';
import { registerWriteCommands } from './registrations/write';
import { VERSION } from './version';

const HELP_FOOTER = `
Command groups:
  setup        init, doctor, mcp
  reading      brief, search, list, open, handoff, stats, workspaces, export
  writing      remember, review, pin, unpin, promote, forget
  maintenance  distill, conflicts, prune, serve
  internal     hook

global flags:
  --json  --cwd <path>

Environment:
  XSCS_HOME  XSCS_DB  XSCS_DISTILLER=claude|codex|none`;

export async function runInteractiveCli(argv: string[]): Promise<void> {
    const cli = cac('xscs');
    cli.usage('<command> [options]');
    cli.option('--json', 'Emit machine-readable JSON');
    cli.option('--cwd <path>', 'Resolve the workspace from this path');

    registerSetupCommands(cli);
    registerReadCommands(cli);
    registerWriteCommands(cli);
    registerMaintenanceCommands(cli);

    cli.command('mcp', 'Run the MCP server over stdio');
    cli.command('hook', 'Process a harness lifecycle event');
    cli.command('help', 'Display this message').action(() => {
        cli.unsetMatchedCommand();
        cli.outputHelp();
    });

    cli.help(() => console.log(HELP_FOOTER));
    cli.version(VERSION);
    cli.addEventListener('command:*', (event) => {
        const command = (event as CustomEvent<string>).detail;
        console.error(`unknown command: ${command}\n`);
        cli.outputHelp();
        process.exitCode = 1;
    });

    cli.parse(['bun', 'xscs', ...argv], { run: false });
    if (!cli.matchedCommand && argv.length === 0) {
        cli.outputHelp();
        return;
    }
    await cli.runMatchedCommand();
}

import type cac from 'cac';

import { cmdForget, cmdPin, cmdPromote, cmdRemember, cmdReview } from '../commands';
import { type CliOptions,commandInput } from './input';

export function registerWriteCommands(cli: ReturnType<typeof cac>): void {
    cli.command('remember [...title]', 'Store durable context explicitly')
        .option('--type <type>', 'Memory item type')
        .option('--title <title>', 'One-line title')
        .option('--body <body>', 'Detailed body')
        .option('--why <reason>', 'Why this is worth remembering')
        .option('--pin', 'Pin the item')
        .option('--scope <scope>', 'global, workspace, branch, or session')
        .option('--tag <tag>', 'Tag; repeat or use commas')
        .option('--confidence <number>', 'Confidence from 0 to 1')
        .action((title: string[], options: CliOptions) => cmdRemember(commandInput('remember', title, options)));

    cli.command('review', 'Triage items proposed by distillation')
        .option('--accept <id>', 'Accept an item; repeat or use commas')
        .option('--reject <id>', 'Reject an item; repeat or use commas')
        .option('--accept-all', 'Accept the complete review queue')
        .action((options: CliOptions) => cmdReview(commandInput('review', [], options)));

    cli.command('pin <...ids>', 'Pin one or more items').action((ids: string[], options: CliOptions) =>
        cmdPin(commandInput('pin', ids, options), true),
    );
    cli.command('unpin <...ids>', 'Unpin one or more items').action((ids: string[], options: CliOptions) =>
        cmdPin(commandInput('unpin', ids, options), false),
    );
    cli.command('promote <...ids>', 'Move items to a wider scope')
        .option('--scope <scope>', 'global, workspace, or branch', { default: 'global' })
        .action((ids: string[], options: CliOptions) => cmdPromote(commandInput('promote', ids, options)));
    cli.command('forget <...ids>', 'Delete stored items').action((ids: string[], options: CliOptions) =>
        cmdForget(commandInput('forget', ids, options)),
    );
}

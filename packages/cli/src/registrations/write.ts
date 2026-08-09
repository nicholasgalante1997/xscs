import {
    ItemScope,
    ItemType,
} from '@xscs/core';
import type cac from 'cac';

import { cmdForget, cmdPin, cmdPromote, cmdRemember, cmdReview } from '../workflows/write';
import {
    booleanOption,
    type CliOptions,
    contextInput,
    listOption,
    numberOption,
    stringOption,
} from './input';

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
        .action((positionalTitle: string[], options: CliOptions) =>
            cmdRemember({
                ...contextInput(options),
                positionalTitle,
                type: ItemType.safeParse(stringOption(options.type)).data,
                title: stringOption(options.title),
                body: stringOption(options.body),
                why: stringOption(options.why),
                pin: booleanOption(options.pin),
                scope: ItemScope.safeParse(stringOption(options.scope)).data,
                tags: listOption(options.tag),
                confidence: numberOption(options.confidence),
            }),
        );

    cli.command('review', 'Triage items proposed by distillation')
        .option('--accept <id>', 'Accept an item; repeat or use commas')
        .option('--reject <id>', 'Reject an item; repeat or use commas')
        .option('--accept-all', 'Accept the complete review queue')
        .action((options: CliOptions) =>
            cmdReview({
                ...contextInput(options),
                accept: listOption(options.accept),
                reject: listOption(options.reject),
                acceptAll: booleanOption(options.acceptAll),
            }),
        );

    cli.command('pin <...ids>', 'Pin one or more items').action((ids: string[], options: CliOptions) =>
        cmdPin({ ...contextInput(options), ids }, true),
    );
    cli.command('unpin <...ids>', 'Unpin one or more items').action((ids: string[], options: CliOptions) =>
        cmdPin({ ...contextInput(options), ids }, false),
    );
    cli.command('promote <...ids>', 'Move items to a wider scope')
        .option('--scope <scope>', 'global, workspace, or branch', { default: 'global' })
        .action((ids: string[], options: CliOptions) =>
            cmdPromote({ ...contextInput(options), ids, scope: stringOption(options.scope) ?? 'global' }),
        );
    cli.command('forget <...ids>', 'Delete stored items').action((ids: string[], options: CliOptions) =>
        cmdForget({ ...contextInput(options), ids }),
    );
}

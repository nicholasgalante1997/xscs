import { describe, expect, test } from 'bun:test';

import { isEmbeddedEntry } from './process';

describe('isEmbeddedEntry', () => {
    test('recognises the POSIX embedded filesystem', () => {
        expect(isEmbeddedEntry('/$bunfs/root/index.js')).toBe(true);
    });

    test('recognises the Windows embedded filesystem', () => {
        // Bun spells the standalone virtual filesystem "B:\~BUN\..." on
        // Windows. Matching only "$bunfs" made every standalone Windows hook
        // command carry an unusable embedded path as an extra argument.
        expect(isEmbeddedEntry(String.raw`B:\~BUN\root\index.js`)).toBe(true);
        expect(isEmbeddedEntry('B:/~BUN/root/index.js')).toBe(true);
    });

    test('treats real on-disk entrypoints as external', () => {
        expect(isEmbeddedEntry('/home/runner/xscs/packages/cli/dist/xscs.js')).toBe(false);
        expect(isEmbeddedEntry(String.raw`C:\Program Files\xscs\packages\cli\dist\xscs.js`)).toBe(false);
    });
});

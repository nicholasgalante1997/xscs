import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

const SOURCE = import.meta.dir;

describe('hook-first module boundary', () => {
    test('hook selection happens before the interactive command graph', () => {
        const bootstrap = source('bootstrap.ts');
        expect(bootstrap.indexOf("command === 'hook'")).toBeLessThan(bootstrap.indexOf("import('./cli')"));
        expect(bootstrap.indexOf("command === 'mcp'")).toBeLessThan(bootstrap.indexOf("import('./cli')"));
    });

    test('the hook implementation has no CLI, dashboard, or React dependency', () => {
        const hook = source('hook.ts');
        for (const forbidden of ['cac', '@xscs/dashboard', 'react', './cli', './registrations']) {
            expect(hook).not.toContain(forbidden);
        }
    });

    test('dashboard loading remains dynamic and serve-only', () => {
        const maintenance = source('registrations/maintenance.ts');
        expect(maintenance).toContain("cli.command('serve'");
        expect(maintenance).toContain("await import('@xscs/dashboard')");
        expect(maintenance).not.toMatch(/^import .*@xscs\/dashboard/m);
    });

    test('the unauthenticated dashboard can only bind to loopback', () => {
        const dashboard = source('../../../apps/dashboard/src/server.ts');
        expect(dashboard).toContain("hostname: '127.0.0.1'");
        expect(dashboard).not.toContain('opts.hostname');
        expect(dashboard).not.toMatch(/hostname\??:\s*string/);
    });
});

function source(path: string): string {
    return readFileSync(resolve(SOURCE, path), 'utf8');
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ensureWorkspace, findWorkspaceByRootOrName, openStore } from '@xscs/core';

import { applyAction, loadState, resolveConflict, search } from './api';
import { renderShell } from './shell';
import type { ActionRequest } from './types';

export interface ServeOptions {
    port?: number;
    hostname?: string;
    open?: boolean;
    /** Working directory used to pick the default workspace. */
    cwd?: string;
    branch?: string | null;
}

/**
 * Deliberately a local, single-process, no-auth server bound to loopback. The
 * store contains verbatim excerpts of a user's sessions; it has no business being
 * reachable from anywhere but this machine.
 */
export async function serveDashboard(opts: ServeOptions = {}): Promise<{ url: string; stop: () => void }> {
    const db = openStore();
    const cwd = opts.cwd ?? process.cwd();
    const here = ensureWorkspace(db, cwd);
    const branch = opts.branch ?? null;
    const clientJs = await resolveClientBundle();

    const server = Bun.serve({
        port: opts.port ?? 4319,
        hostname: opts.hostname ?? '127.0.0.1',
        development: false,
        async fetch(req) {
            const url = new URL(req.url);

            if (url.pathname === '/app.js') {
                return new Response(clientJs, {
                    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
                });
            }

            if (url.pathname === '/api/state') {
                const key = url.searchParams.get('workspace') ?? here.root;
                return json(loadState(db, key, branch));
            }

            if (url.pathname === '/api/search') {
                const key = url.searchParams.get('workspace') ?? here.root;
                const ws = findWorkspaceByRootOrName(db, key);
                return json(search(db, url.searchParams.get('q') ?? '', ws?.id ?? null));
            }

            if (url.pathname === '/api/action' && req.method === 'POST') {
                const body = (await req.json()) as ActionRequest;
                if (!Array.isArray(body.ids) || typeof body.action !== 'string') {
                    return json({ error: 'ids[] and action are required' }, 400);
                }
                return json(applyAction(db, body, branch));
            }

            if (url.pathname === '/api/conflict' && req.method === 'POST') {
                const body = (await req.json()) as { keep: string; drop: string; mode: 'supersede' | 'dismiss' };
                if (!body.keep || !body.drop) return json({ error: 'keep and drop are required' }, 400);
                resolveConflict(db, body.keep, body.drop, body.mode === 'dismiss' ? 'dismiss' : 'supersede');
                return json({ ok: true });
            }

            if (url.pathname === '/' || url.pathname === '/index.html') {
                return new Response(renderShell(), {
                    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
                });
            }

            return new Response('not found', { status: 404 });
        },
    });

    const urlString = `http://${server.hostname}:${server.port}`;
    console.log(`xscs dashboard → ${urlString}`);
    if (opts.open !== false) openBrowser(urlString);

    return { url: urlString, stop: () => server.stop(true) };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}

/**
 * Built output ships `client/app.js` next to this module. Running from source
 * (dev, or `bun run src/dev.ts`) there is no bundle yet, so build one in memory —
 * which also means the dev loop needs no watcher.
 */
async function resolveClientBundle(): Promise<string> {
    const prebuilt = join(import.meta.dir, 'client', 'app.js');
    if (existsSync(prebuilt)) return Bun.file(prebuilt).text();

    const entry = join(import.meta.dir, 'client', 'main.tsx');
    if (!existsSync(entry)) throw new Error(`dashboard client not found (looked for ${prebuilt} and ${entry})`);

    const result = await Bun.build({
        entrypoints: [entry],
        target: 'browser',
        format: 'esm',
        minify: false,
        define: { 'process.env.NODE_ENV': '"development"' },
    });
    if (!result.success) throw new AggregateError(result.logs, 'dashboard client build failed');
    return result.outputs[0]!.text();
}

function openBrowser(url: string): void {
    const cmd =
        process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', url] : ['xdg-open', url];
    try {
        Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }).unref();
    } catch {
        /* opening a browser is a convenience, never a requirement */
    }
}

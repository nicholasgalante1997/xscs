import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWorkspace, findWorkspaceByRootOrName, openStore, serverPlatform } from '@xscs/core';

import { applyAction, loadState, resolveConflict, search } from './api';
import { renderShell } from './shell';
import type { ActionRequest } from './types';

declare const XSCS_EMBEDDED_DASHBOARD_CLIENT: string | undefined;

export interface ServeOptions {
    port?: number;
    open?: boolean;
    /** Working directory used to pick the default workspace. */
    cwd?: string;
    branch?: string | null;
    /** Development-only source bundler supplied by the Bun composition root. */
    buildClient?: (entry: string) => Promise<string>;
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
    const clientJs = await resolveClientBundle(opts.buildClient);

    const runtime = serverPlatform();
    const server = await runtime.serve({
        port: opts.port ?? 4319,
        hostname: '127.0.0.1',
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
    if (opts.open !== false) runtime.openBrowser(urlString);

    return { url: urlString, stop: () => server.stop() };
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
async function resolveClientBundle(buildClient?: (entry: string) => Promise<string>): Promise<string> {
    if (typeof XSCS_EMBEDDED_DASHBOARD_CLIENT === 'string') return XSCS_EMBEDDED_DASHBOARD_CLIENT;

    const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
    const prebuilt = join(moduleDirectory, 'client', 'app.js');
    if (existsSync(prebuilt)) return readFile(prebuilt, 'utf8');

    const entry = join(moduleDirectory, 'client', 'main.tsx');
    if (!existsSync(entry)) throw new Error(`dashboard client not found (looked for ${prebuilt} and ${entry})`);
    if (!buildClient) throw new Error(`dashboard source build requires a runtime buildClient capability (${entry})`);
    return buildClient(entry);
}

import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';

import type { ServerPlatform } from './server';

async function toRequest(
    request: IncomingMessage,
    hostname: string,
    port: number,
): Promise<Request> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    const method = request.method ?? 'GET';
    return new Request(`http://${hostname}:${port}${request.url ?? '/'}`, {
        method,
        headers: request.headers as HeadersInit,
        body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
}

export const nodeServerPlatform: ServerPlatform = {
    openBrowser(url) {
        const command =
            process.platform === 'darwin'
                ? ['open', url]
                : process.platform === 'win32'
                  ? ['cmd', '/c', 'start', url]
                  : ['xdg-open', url];
        try {
            const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: 'ignore' });
            child.unref();
        } catch {
            // Opening a browser is a convenience.
        }
    },
    serve(input) {
        return new Promise((resolve, reject) => {
            const server = createServer(async (incoming, outgoing) => {
                try {
                    const response = await input.fetch(await toRequest(incoming, input.hostname, input.port));
                    outgoing.statusCode = response.status;
                    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
                    outgoing.end(Buffer.from(await response.arrayBuffer()));
                } catch {
                    outgoing.statusCode = 500;
                    outgoing.end('internal server error');
                }
            });
            server.once('error', reject);
            server.listen(input.port, input.hostname, () => {
                const address = server.address();
                const port = typeof address === 'object' && address ? address.port : input.port;
                resolve({
                    hostname: input.hostname,
                    port,
                    stop() {
                        server.close();
                    },
                });
            });
        });
    },
};

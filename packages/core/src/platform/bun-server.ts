import type { ServerPlatform } from './server';

export const bunServerPlatform: ServerPlatform = {
    openBrowser(url) {
        const command =
            process.platform === 'darwin'
                ? ['open', url]
                : process.platform === 'win32'
                  ? ['cmd', '/c', 'start', url]
                  : ['xdg-open', url];
        try {
            Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' }).unref();
        } catch {
            // Opening a browser is a convenience.
        }
    },
    async serve(input) {
        const server = Bun.serve({
            development: false,
            fetch: input.fetch,
            hostname: input.hostname,
            port: input.port,
        });
        return {
            hostname: server.hostname ?? input.hostname,
            port: server.port ?? input.port,
            stop() {
                void server.stop(true);
            },
        };
    },
};

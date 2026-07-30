export interface ServerInput {
    fetch(request: Request): Response | Promise<Response>;
    hostname: string;
    port: number;
}

export interface RunningServer {
    hostname: string;
    port: number;
    stop(): void;
}

export interface ServerPlatform {
    openBrowser(url: string): void;
    serve(input: ServerInput): Promise<RunningServer>;
}

let platform: ServerPlatform | null = null;

export function configureServerPlatform(next: ServerPlatform): void {
    platform = next;
}

export function serverPlatform(): ServerPlatform {
    if (!platform) throw new Error('Server platform is not configured');
    return platform;
}

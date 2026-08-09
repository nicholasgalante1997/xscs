export type CliErrorKind =
    | 'configuration'
    | 'internal'
    | 'platform'
    | 'storage'
    | 'usage';

export class CliError extends Error {
    readonly kind: CliErrorKind;
    readonly exitCode: number;

    constructor(kind: CliErrorKind, message: string, exitCode = 1, options?: ErrorOptions) {
        super(message, options);
        this.name = 'CliError';
        this.kind = kind;
        this.exitCode = exitCode;
    }
}

export class UsageError extends CliError {
    constructor(message: string, options?: ErrorOptions) {
        super('usage', message, 1, options);
        this.name = 'UsageError';
    }
}

export class ConfigurationError extends CliError {
    constructor(message: string, options?: ErrorOptions) {
        super('configuration', message, 1, options);
        this.name = 'ConfigurationError';
    }
}

export class StorageError extends CliError {
    constructor(message: string, options?: ErrorOptions) {
        super('storage', message, 1, options);
        this.name = 'StorageError';
    }
}

export class PlatformCapabilityError extends CliError {
    constructor(message: string, options?: ErrorOptions) {
        super('platform', message, 1, options);
        this.name = 'PlatformCapabilityError';
    }
}

export class InternalError extends CliError {
    constructor(message: string, options?: ErrorOptions) {
        super('internal', message, 1, options);
        this.name = 'InternalError';
    }
}

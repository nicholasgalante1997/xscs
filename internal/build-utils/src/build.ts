import type { BuildConfig, BuildOutput } from 'bun';

export interface BaseBuildOptions {
    external?: string[];
    format?: BuildConfig['format'];
    minify?: boolean;
    outdir?: string;
    packages?: BuildConfig['packages'];
    sourcemap?: BuildConfig['sourcemap'];
    splitting?: boolean;
    target?: BuildConfig['target'];
}

export interface BuildPlan {
    label: string;
    configs: BuildConfig[];
}

export function createBaseConfig(options: BaseBuildOptions = {}): Partial<BuildConfig> {
    return {
        external: options.external ?? [],
        format: options.format ?? 'esm',
        minify: options.minify ?? false,
        outdir: options.outdir ?? 'dist',
        packages: options.packages ?? 'external',
        sourcemap: options.sourcemap ?? 'external',
        splitting: options.splitting ?? false,
        target: options.target ?? 'bun',
    };
}

export async function runBuild(plan: BuildPlan): Promise<BuildOutput[]> {
    console.log(`Starting build for ${plan.label}...`);
    const start = performance.now();
    const outputs = await Promise.all(plan.configs.map((config) => Bun.build(config)));
    const failures = outputs.filter((output) => !output.success);
    if (failures.length) {
        throw new AggregateError(failures.flatMap((failure) => failure.logs), `${plan.label} build failed`);
    }
    console.log(`Build finished in ${(performance.now() - start).toFixed(2)}ms`);
    return outputs;
}

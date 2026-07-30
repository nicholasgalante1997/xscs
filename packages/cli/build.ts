import { createBaseConfig, runBuild } from "@xscs/internal-build-utils";

export {};

try {
  const manifest = (await Bun.file("package.json").json()) as {
    version: string;
  };
  const define = { XSCS_VERSION: JSON.stringify(manifest.version) };
  await runBuild({
    label: "cross-session-summary",
    configs: [
      {
        ...createBaseConfig({ external: ["cac"], packages: "bundle" }),
        define,
        entrypoints: ["index.ts"],
        naming: { entry: "xscs.js" },
      },
      {
        ...createBaseConfig({
          external: ["cac"],
          packages: "bundle",
          target: "node",
        }),
        define,
        entrypoints: ["node.ts"],
        naming: { entry: "xscs.node.js" },
      },
    ],
  });
  await Bun.write(
    "./dist/client/app.js",
    Bun.file("../../apps/dashboard/dist/client/app.js"),
  );
  await Bun.$`chmod +x ./dist/xscs.js`;
  await Bun.$`chmod +x ./dist/xscs.node.js`;
} catch (error) {
  console.error("Build failed:", error);
  await Bun.$`rm -rf ./dist`;
  process.exit(1);
}

export const electronBuildOptions = {
  entryPoints: {
    main: "electron/main.ts",
    preload: "electron/preload.ts",
    guard: "electron/security/guard-entry.ts",
  },
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "sql.js"],
  sourcemap: true,
};

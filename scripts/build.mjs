import { build } from "esbuild";
import { electronBuildOptions } from "./electron-build.mjs";
await build(electronBuildOptions);

import { defineConfig } from "tsdown";

// One plain-Node file with every dependency inlined: it is attached to each GitHub release and
// copied into the image, and needs neither the repository nor `node_modules` to run.
export default defineConfig({
  entry: { "wg-hunt": "src/index.ts" },
  format: "esm",
  platform: "node",
  outExtensions: () => ({ js: ".mjs" }),
  noExternal: [/.*/],
  banner: "#!/usr/bin/env node",
});

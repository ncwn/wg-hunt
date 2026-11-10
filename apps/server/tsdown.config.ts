import { defineConfig } from "tsdown";

// `@wg-hunt/core` exports TypeScript sources, so the server bundle inlines it
// rather than leaving Node to resolve `.ts` files at runtime.
export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  noExternal: [/^@wg-hunt\//],
});

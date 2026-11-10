import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/{src,test}/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    setupFiles: ["./test/no-network.ts"],
  },
});

import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalysisProvider } from "@wg-hunt/core";
import { fakeProvider, outputWith, sure } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { tempDataDir } from "./helpers.js";
import { bootOffers } from "./offers-harness.js";

const KEY = "sk-ant-api03-test-key-do-not-leak-0123456789";
const mode = (path: string) => statSync(path).mode & 0o777;

describe("the data folder's permissions", () => {
  it("are private for a new data folder", () => {
    const dir = join(tempDataDir(), "fresh");
    bootOffers({ dataDir: dir });
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "wg-hunt.sqlite"))).toBe(0o600);
    expect(mode(join(dir, "access-token"))).toBe(0o600);
  });

  it("are tightened at boot for a data folder that already exists", () => {
    const dir = tempDataDir();
    bootOffers({ dataDir: dir }).runtime.close();
    chmodSync(dir, 0o755);
    chmodSync(join(dir, "wg-hunt.sqlite"), 0o644);
    chmodSync(join(dir, "access-token"), 0o644);

    bootOffers({ dataDir: dir });

    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "wg-hunt.sqlite"))).toBe(0o600);
    expect(mode(join(dir, "access-token"))).toBe(0o600);
  });

  it("are tightened for a folder made earlier with the loose defaults", () => {
    const dir = tempDataDir();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o775);
    writeFileSync(join(dir, "access-token"), `${"x".repeat(43)}\n`, { mode: 0o664 });
    chmodSync(join(dir, "access-token"), 0o664);

    bootOffers({ dataDir: dir });

    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "access-token"))).toBe(0o600);
  });
});

describe("shutdown", () => {
  it("lets an analysis in flight finish before the database closes", async () => {
    const dir = tempDataDir();
    const inner = fakeProvider([
      outputWith({ anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") } }),
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const asked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: AnalysisProvider = {
      async analyse(request) {
        started();
        await gate;
        return inner.provider.analyse(request);
      },
    };
    const h = bootOffers({
      dataDir: dir,
      analysis: { providerFor: () => provider, sleep: async () => {} },
    });
    expect((await h.call("PUT", "/secrets/anthropic", { value: KEY })).status).toBe(200);
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await asked;

    let closed = false;
    const shutdown = h.runtime.shutdown().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);

    release();
    await shutdown;

    const again = bootOffers({ dataDir: dir });
    const [offer] = (await again.json("GET", "/offers?includeHidden=true")).body.items;
    expect(offer.analysisState).toBe("analyzed");
  });
});

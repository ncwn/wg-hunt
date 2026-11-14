import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_SWEEP_ATTEMPTS } from "../src/crawl/sweeps.js";
import { crawlJobs } from "../src/db/schema.js";
import { adapterFixture, berlin, bootSweep, MINUTE } from "./sweep-harness.js";

describe("a Stale confirmation whose handler throws", () => {
  it("counts as an unanswered attempt: tried a bounded number of times, each after a Resume", async () => {
    const h = bootSweep();
    h.site.listing = h.cards(9001000, 3);
    await h.addSearch();
    await h.crawlUntil(berlin(4, 23));

    h.site.listing = h.site.listing.slice(0, 2);
    h.site.pages.set(9001002, adapterFixture("deactivated"));
    const dataDir = dirname(h.runtime.db.$client.name);
    const stored = join(dataDir, "offer-pages", "wg-gesucht", "9001002.html.gz");
    rmSync(stored);
    mkdirSync(stored);
    writeFileSync(join(stored, "in-the-way"), "");

    const from = h.clock.now;
    await h.crawlUntil(berlin(5, 14));
    expect((await h.json("GET", "/crawl")).body).toMatchObject({
      state: "layout-changed",
      paused: { reason: "layout-changed", cause: "handler-error" },
    });
    for (let round = 0; round < MAX_SWEEP_ATTEMPTS + 2; round++) {
      await h.json("POST", "/crawl/resume");
      await h.crawlUntil(h.clock.now + 90 * MINUTE);
    }

    expect(h.requestsOf("stale-confirmation", from)).toHaveLength(MAX_SWEEP_ATTEMPTS);
    expect(
      h.runtime.db
        .select()
        .from(crawlJobs)
        .all()
        .map((j) => j.kind),
    ).not.toContain("stale-confirmation");
  });
});

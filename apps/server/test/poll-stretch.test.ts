import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { readJson, writeJson } from "../src/crawl/kv.js";
import { defaultCrawlSettings, saveCrawlSettings } from "../src/crawl/settings.js";
import { loggedPath } from "../src/crawl/source-paths.js";
import { crawlJobs } from "../src/db/schema.js";
import { bootSweep, DAY, MINUTE } from "./sweep-harness.js";

const CATEGORIES = ["flatshare-room", "one-room-flat", "flat", "house"] as const;

/** In minutes. */
async function waitsAfterFirstPoll(
  searchCount: number,
  options: { halfBudget?: boolean; unknownCity?: boolean } = {},
) {
  const h = bootSweep({ random: () => 0.5 });
  const settings = defaultCrawlSettings();
  saveCrawlSettings(
    h.runtime.db,
    { ...settings, pacing: { ...settings.pacing, sessionSize: 10_000, hourlyCap: 600 } },
    h.clock.now,
  );
  if (options.halfBudget) {
    // As a successful probe after a Cooldown leaves it: the caps are halved for a day.
    const engine = readJson(h.runtime.db, "crawl.engine") as object | undefined;
    writeJson(
      h.runtime.db,
      "crawl.engine",
      { ...engine, halfBudgetUntil: h.clock.now + DAY },
      h.clock.now,
    );
  }
  for (const category of CATEGORIES.slice(0, searchCount)) {
    await h.addSearch({ categories: [category], pollInterval: { minMinutes: 30, maxMinutes: 60 } });
  }
  if (options.unknownCity) {
    // Enabled and in every category, but the adapter has no id for the city: nothing is sent.
    await h.addSearch({
      city: "Teststadt",
      categories: [...CATEGORIES],
      pollInterval: { minMinutes: 30, maxMinutes: 60 },
    });
  }
  // Long enough for every first poll to go out, short of the second round.
  await h.crawlUntil(h.clock.now + 20 * MINUTE);
  const first = new Map(h.requestsOf("poll").map((r) => [r.path, r.at]));
  const waits = h.runtime.db
    .select()
    .from(crawlJobs)
    .where(eq(crawlJobs.kind, "poll"))
    .all()
    .map((job) => (job.dueAt.getTime() - (first.get(loggedPath(job.path)) ?? Number.NaN)) / MINUTE);
  return waits;
}

describe("stretching poll intervals to fit the budget", () => {
  it("keeps the Search's own interval while polls plus Sweeps fit in half the daily cap", async () => {
    const waits = await waitsAfterFirstPoll(2);
    expect(waits).toHaveLength(2);
    for (const wait of waits) expect(wait).toBeCloseTo(45, 5);
  });

  it("does not stretch for an enabled Search whose city the Source cannot resolve", async () => {
    // Counted, its 110 polls + 60 Sweep pages would stretch the two working Searches 2.75 times.
    const waits = await waitsAfterFirstPoll(2, { unknownCity: true });
    expect(waits).toHaveLength(2);
    for (const wait of waits) expect(wait).toBeCloseTo(45, 5);
  });

  it("stretches every Search's interval by the same factor when they would not", async () => {
    // Four Searches: 110 polls + 60 Sweep pages > 150, so each wait grows by 110 / 90.
    const waits = await waitsAfterFirstPoll(4);
    expect(waits).toHaveLength(4);
    for (const wait of waits) expect(wait).toBeCloseTo(45 * (110 / 90), 1);
  });

  it("stretches against the halved cap during the half-budget period after a Cooldown", async () => {
    // Half of 300 is 150: two Searches' 55 polls + 30 Sweep pages pass its half (75), so each
    // wait grows by 55 / 45, though they fit the full cap.
    const waits = await waitsAfterFirstPoll(2, { halfBudget: true });
    expect(waits).toHaveLength(2);
    for (const wait of waits) expect(wait).toBeCloseTo(45 * (55 / 45), 1);
  });
});

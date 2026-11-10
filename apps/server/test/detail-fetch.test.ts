import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  afterFailedFetch,
  DETAIL_STATES,
  firstDetailState,
  MAX_DETAIL_ATTEMPTS,
  SETTLED_WITHOUT_PAGE,
  wantsRefetch,
} from "../src/crawl/detail-fetch.js";
import { queuedJobs } from "../src/crawl/queue.js";
import { seenAds } from "../src/db/schema.js";
import { prune } from "../src/retention/prune.js";
import { HOUR, MINUTE, MORNING, pollingHarness } from "./polling-harness.js";

const offerPath = (id: number) => `/wg-zimmer-in-Teststadt-Mitte.${id}.html`;
const DAY = 24 * HOUR;

describe("the detail-fetch states", () => {
  it("are one closed list; the ones settled without a page are among them", () => {
    expect([...DETAIL_STATES].sort()).toEqual(
      ["pending", "fetched", "failed", "skipped", "priced-out"].sort(),
    );
    for (const state of SETTLED_WITHOUT_PAGE) expect(DETAIL_STATES).toContain(state);
    expect(SETTLED_WITHOUT_PAGE).not.toContain("pending");
    expect(SETTLED_WITHOUT_PAGE).not.toContain("fetched");
  });

  it("start skipped for a card too old, priced-out above the ceiling, else pending", () => {
    expect(firstDetailState({ tooOld: true, pricedOut: true })).toBe("skipped");
    expect(firstDetailState({ tooOld: false, pricedOut: true })).toBe("priced-out");
    expect(firstDetailState({ tooOld: false, pricedOut: false })).toBe("pending");
  });

  it("are fetched again after a Bump (skipped, failed) or a price within the ceiling (priced-out), if fresh", () => {
    const card = { bumped: false, fresh: true, pricedOut: false };
    expect(wantsRefetch("skipped", { ...card, bumped: true })).toBe(true);
    expect(wantsRefetch("failed", { ...card, bumped: true })).toBe(true);
    expect(wantsRefetch("failed", card)).toBe(false);
    expect(wantsRefetch("priced-out", card)).toBe(true);
    expect(wantsRefetch("priced-out", { ...card, pricedOut: true })).toBe(false);
    expect(wantsRefetch("priced-out", { ...card, fresh: false })).toBe(false);
    expect(wantsRefetch("pending", { ...card, bumped: true })).toBe(false);
    expect(wantsRefetch("fetched", { ...card, bumped: true })).toBe(false);
  });

  it("count failures, and give up after the last attempt", () => {
    expect(afterFailedFetch(0)).toEqual({ detailState: "pending", detailAttempts: 1 });
    expect(afterFailedFetch(MAX_DETAIL_ATTEMPTS - 1)).toEqual({
      detailState: "failed",
      detailAttempts: MAX_DETAIL_ATTEMPTS,
    });
  });
});

describe("detailAttempts", () => {
  it("counts only failures: a first fetch that works leaves it at 0", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001], MORNING - 10 * MINUTE) : []));
    await h.drive(MORNING + 30 * MINUTE);
    expect(h.seenAd("9000001")).toMatchObject({ detailState: "fetched", detailAttempts: 0 });
  });

  it("keeps the failures before a fetch that worked", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001], MORNING - 10 * MINUTE) : []));
    const search0 = h.behaviour.route;
    let failures = 1;
    h.behaviour.route = (path) =>
      path === offerPath(9000001) && failures-- > 0 ? { status: 500, body: "" } : search0(path);
    await h.drive(MORNING + 3 * HOUR);
    expect(h.seenAd("9000001")).toMatchObject({ detailState: "fetched", detailAttempts: 1 });
  });
});

describe("a detail fetch whose handler throws", () => {
  it("counts as a failed attempt: retried a bounded number of times, then failed", async () => {
    const h = pollingHarness();
    // The snapshot cannot be written: where its folder should be is a file.
    writeFileSync(join(h.dataDir, "offer-pages"), "not a folder");
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001], MORNING - 10 * MINUTE) : []));

    await h.drive(h.clock.now + 3 * HOUR);
    expect(h.engine.status()).toMatchObject({
      state: "layout-changed",
      paused: { reason: "layout-changed", cause: "handler-error" },
    });
    expect(h.seenAd("9000001")).toMatchObject({ detailState: "pending", detailAttempts: 1 });
    for (let round = 0; round < MAX_DETAIL_ATTEMPTS + 2; round++) {
      h.engine.resume();
      h.polling.sync();
      await h.drive(h.clock.now + 3 * HOUR);
    }

    expect(h.sent.filter((path) => path === offerPath(9000001))).toHaveLength(MAX_DETAIL_ATTEMPTS);
    expect(h.seenAd("9000001")).toMatchObject({
      detailState: "failed",
      detailAttempts: MAX_DETAIL_ATTEMPTS,
    });
    expect(queuedJobs(h.db, "new-offer")).toEqual([]);
  });
});

describe("the orphan seen-ad prune", () => {
  it("deletes old rows settled without a page, and keeps pending and fetched ones", () => {
    const h = pollingHarness();
    const old = new Date(MORNING - 400 * DAY);
    for (const [n, detailState] of DETAIL_STATES.entries()) {
      h.db
        .insert(seenAds)
        .values({
          source: "wg-gesucht",
          adId: String(9100000 + n),
          firstSeenAt: old,
          lastSeenAt: old,
          category: "flatshare-room",
          card: "{}",
          detailState,
        })
        .run();
    }
    prune(h.db, h.dataDir, MORNING);
    expect(
      h
        .seen()
        .map((row) => row.detailState)
        .sort(),
    ).toEqual(["fetched", "pending"]);
  });
});

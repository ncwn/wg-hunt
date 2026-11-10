import { defaultCrawlSettings, saveCrawlSettings } from "../src/crawl/settings.js";
import { offerPageWith } from "./fixtures/search-pages.js";
import { bootSweep, DAY, HOUR, MINUTE } from "./sweep-harness.js";

export { DAY, HOUR, MINUTE };

function ageText(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / MINUTE));
  if (minutes < 60) return `${minutes} Min.`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} Std.`;
  return `${Math.floor(minutes / (24 * 60))} T.`;
}

type Room = { publishedAt: number; title: string };

function bootRooms(firstId: number, count: number, options: { hourlyPolls?: boolean } = {}) {
  const h = bootSweep({ random: () => 0.5 });
  const rooms = new Map<number, Room>();
  for (let i = 0; i < count; i++) {
    rooms.set(firstId + i, { publishedAt: h.clock.now - 2 * HOUR, title: `Zimmer ${firstId + i}` });
  }
  Object.defineProperty(h.site, "listing", {
    get: () =>
      [...rooms.entries()]
        .sort((a, b) => b[1].publishedAt - a[1].publishedAt || a[0] - b[0])
        .map(([id, room]) => ({
          id,
          age: ageText(h.clock.now - room.publishedAt),
          title: room.title,
        })),
  });

  const defaults = defaultCrawlSettings();
  const pacing = (change: object = {}) =>
    saveCrawlSettings(
      h.runtime.db,
      {
        ...defaults,
        pacing: { ...defaults.pacing, sessionSize: 10_000, hourlyCap: 600, ...change },
      },
      h.clock.now,
    );
  pacing({ dailyCap: 600 });

  const edit = (id: number, change: Partial<Room>, page?: { title: string; warmRent: number }) => {
    const room = rooms.get(id);
    if (room === undefined) throw new Error(`no room ${id}`);
    rooms.set(id, { ...room, ...change });
    if (page !== undefined) h.site.pages.set(id, offerPageWith(page));
  };
  const bump = (
    id: number,
    change: Partial<Room> = {},
    page?: { title: string; warmRent: number },
  ) => edit(id, { publishedAt: h.clock.now - 3 * MINUTE, ...change }, page);

  const settings = (recheck: { enabled: boolean; maxPageAgeHours: number }) => {
    const current = defaultCrawlSettings();
    saveCrawlSettings(
      h.runtime.db,
      {
        ...current,
        pacing: { ...current.pacing, sessionSize: 10_000, hourlyCap: 600, dailyCap: 600 },
        recheck,
      },
      h.clock.now,
    );
  };

  const search = h.addSearch({
    pollInterval: { minMinutes: options.hourlyPolls === false ? 1440 : 60, maxMinutes: 60 },
  });

  const rechecksOf = (id: number, from = 0) =>
    h.requestsOf("recheck", from).filter((r) => r.path.endsWith(`.${id}.html`));

  return { ...h, rooms, edit, bump, pacing, settings, search, rechecksOf };
}

export async function settledRooms(firstId: number, count: number) {
  const w = bootRooms(firstId, count);
  await w.search;
  await w.crawlUntil(w.clock.now + 3 * HOUR);
  return w;
}

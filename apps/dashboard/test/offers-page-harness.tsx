import { screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import {
  driveCrawl,
  fakeSource,
  MINUTE,
  MORNING,
  offerPageWith,
  relaxCaps,
} from "../../server/test/offers-harness.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

export type Ad = { id: number; title: string; warmRent: number };
export type Server = ReturnType<typeof realServer>;

export const THREE: Ad[] = [
  { id: 9000001, title: "Cheap room", warmRent: 450 },
  { id: 9000002, title: "Dear room", warmRent: 520 },
  { id: 9000003, title: "Dearest room", warmRent: 700 },
];

export async function limitRent(server: Server) {
  const filters = await (await server.call("GET", "/filters")).json();
  filters.maxRent.limit = 500;
  filters.maxRent.margin = { value: 50, unit: "absolute" };
  await server.call("PUT", "/filters", filters);
}

/**
 * The server's clock stands still at `clock.now`; call `vi.useFakeTimers({ toFake: ["Date"] })`
 * first and the browser's Date follows it, so "seen" times line up with the server's.
 */
export async function openOffers(
  ads: Ad[] = THREE,
  route = "/offers/all",
  prepare?: (ctx: { server: Server; clock: { now: number } }) => Promise<unknown>,
  fetchVia?: (
    fetch: (request: Request) => Promise<Response>,
  ) => (request: Request) => Promise<Response>,
) {
  const source = fakeSource();
  const clock = { now: MORNING };
  const server = realServer({ fetcher: source.fetcher, clock: () => clock.now });
  await server.signIn();
  relaxCaps(server.runtime, clock.now);
  source.site.cards = ads.map(({ id, title }) => ({ id, age: "5 Min.", title }));
  for (const ad of ads) source.site.pages.set(ad.id, offerPageWith(ad));
  await server.call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
  await driveCrawl(server.runtime, clock, clock.now + 4 * 60 * MINUTE);
  const answered = await prepare?.({ server, clock });
  const at = typeof answered === "string" ? answered : route;
  vi.setSystemTime(clock.now);
  const events = fakeEventStream();
  const requests: string[] = [];
  const fetch = async (request: Request) => {
    requests.push(
      `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`,
    );
    return (fetchVia ? fetchVia(server.fetch) : server.fetch)(request);
  };
  const rendered = renderDashboard(fetch, at, events.stream);
  await screen.findByRole("heading", { level: 1 });
  return { ...rendered, server, source, events, clock, requests };
}

export async function crawlMore(
  ctx: { server: Server; source: ReturnType<typeof fakeSource>; clock: { now: number } },
  ad: Ad,
  after = 60 * MINUTE,
) {
  ctx.clock.now += after;
  vi.setSystemTime(ctx.clock.now);
  ctx.source.site.cards = [{ id: ad.id, age: "5 Min.", title: ad.title }, ...ctx.source.site.cards];
  ctx.source.site.pages.set(ad.id, offerPageWith(ad));
  await driveCrawl(ctx.server.runtime, ctx.clock, ctx.clock.now + 2 * 60 * MINUTE);
  const items = (await (await ctx.server.call("GET", "/offers?includeHidden=true")).json()).items;
  return items.find((item: { title: string }) => item.title === ad.title);
}

export const list = () => within(screen.getByRole("region", { name: "Offers" }));
export const detail = () => within(screen.getByRole("complementary", { name: "Offer details" }));
const nav = () => within(screen.getByRole("navigation", { name: "Main" }));
export const newBadge = () =>
  nav()
    .getByRole("link", { name: /Offers/ })
    .querySelector(".rail-badge");
const titleOf = (row: Element) => {
  const title = row.querySelector(".wh-offer-title")?.cloneNode(true) as HTMLElement | undefined;
  title?.querySelector(".wh-new")?.remove();
  return title?.textContent ?? "";
};
const rows = () => Array.from(list().getByRole("table").querySelectorAll("tbody > tr"));
export const titles = () => rows().map(titleOf);
export const rowOf = (title: string) => {
  const row =
    rows().find((r) => titleOf(r) === title) ?? rows().find((r) => titleOf(r).includes(title));
  if (!row) throw new Error(`No row for "${title}": ${titles().join(", ")}`);
  return row as HTMLElement;
};
export const show = () => within(screen.getByRole("group", { name: "Show" }));
export async function openDetails(user: { click: (el: Element) => Promise<void> }) {
  await detail().findByRole("article");
  const heads = (await detail().findAllByRole("button", { expanded: false })).filter((button) =>
    button.matches(".od-fold > .wh-disclosure > .wh-disclosure-head"),
  );
  for (const head of heads) await user.click(head);
}

export const titleLink = (title: string) =>
  rowOf(title).querySelector<HTMLAnchorElement>("a.wh-offer-link") as HTMLAnchorElement;

export async function choose(
  user: { click: (el: Element) => Promise<void> },
  title: string,
): Promise<void> {
  await waitFor(() => rowOf(title));
  await user.click(titleLink(title));
  await openDetails(user);
}

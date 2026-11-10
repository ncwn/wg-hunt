import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import {
  driveCrawl,
  fakeSource,
  MINUTE,
  MORNING,
  offerPageWith,
  relaxCaps,
} from "../../server/test/offers-harness.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

export type Ad = { id: number; title: string; warmRent: number };

const THREE_RENTS: Ad[] = [
  { id: 9000001, title: "Cheap", warmRent: 450 },
  { id: 9000002, title: "Dear", warmRent: 520 },
  { id: 9000003, title: "Dearest", warmRent: 700 },
];

export async function openProfile(ads: Ad[] = THREE_RENTS, route = "/profile") {
  const source = fakeSource();
  const clock = { now: MORNING };
  const server = realServer({ fetcher: source.fetcher, clock: () => clock.now });
  await server.signIn();
  relaxCaps(server.runtime, clock.now);
  if (ads.length > 0) {
    source.site.cards = ads.map(({ id, title }) => ({ id, age: "5 Min.", title }));
    for (const ad of ads) source.site.pages.set(ad.id, offerPageWith(ad));
    await server.call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
    await driveCrawl(server.runtime, clock, clock.now + 4 * 60 * MINUTE);
  }
  const requested: string[] = [];
  const written: string[] = [];
  let presetBroken = false;
  let previewBroken = false;
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname.replace(/^\/api\/v1/, "");
    requested.push(path);
    if (request.method !== "GET") written.push(`${request.method} ${path}`);
    if (previewBroken && path === "/ranking/preview") throw new TypeError("Failed to fetch");
    if (presetBroken && path === "/presets/example")
      return new Response(JSON.stringify({ title: "Server error", detail: "the preset broke" }), {
        status: 500,
        headers: { "Content-Type": "application/problem+json" },
      });
    return server.fetch(request);
  };
  const rendered = renderDashboard(fetch, route);
  await screen.findByRole("heading", { level: 1, name: "Profile & Filters" });
  await screen.findByRole("heading", { level: 2, name: "About you" });
  return {
    ...rendered,
    server,
    requested,
    written,
    breakPreset: () => {
      presetBroken = true;
    },
    failPreview: (on: boolean) => {
      previewBroken = on;
    },
  };
}

export const saved = async (server: ReturnType<typeof realServer>, what: "profile" | "filters") =>
  (await server.call("GET", `/${what}`)).json();

export const preview = () => screen.getByRole("complementary", { name: "Draft preview" });

/**
 * While a newer draft is previewed the panel keeps the last headline under "Updating…" with Save
 * off, so the headline alone doesn't mean the preview is in.
 */
export async function previewed(headline: RegExp = /would be ranked differently/) {
  await waitFor(() => {
    const panel = within(preview());
    expect(panel.queryByRole("status")).toBeNull();
    panel.getByText(headline);
  });
  return within(preview()).getByText(headline);
}

export const cardsMarked = () =>
  ["About you", "What the room should be"].every(
    (name) => screen.getByRole("region", { name }).getAttribute("data-draft") === "true",
  );

export async function discard(user: { click: (element: Element) => Promise<void> }) {
  await user.click(within(preview()).getByRole("button", { name: "Discard" }));
  const question = screen.getByRole("alertdialog", { name: "Discard your unsaved changes?" });
  await user.click(within(question).getByRole("button", { name: "Discard" }));
}

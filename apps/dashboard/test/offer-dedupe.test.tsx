// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type AdSpec,
  adPage,
  ROOM_TEXT,
  ROOM_TEXT_EDITED,
} from "../../server/test/dedupe-harness.js";
import {
  driveCrawl,
  fakeSource,
  MINUTE,
  MORNING,
  relaxCaps,
} from "../../server/test/offers-harness.js";
import { choose, titles } from "./offers-page-harness.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

/** `ads` are listed newest first, as a Source does. */
async function openOffers(ads: AdSpec[]) {
  const source = fakeSource();
  const clock = { now: MORNING };
  const server = realServer({ fetcher: source.fetcher, clock: () => clock.now });
  await server.signIn();
  relaxCaps(server.runtime, clock.now);
  source.site.cards = ads.map((ad) => ({ id: ad.adId, age: "5 Min.", title: ad.title }));
  for (const ad of ads) source.site.pages.set(ad.adId, adPage(ad));
  await server.call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
  await driveCrawl(server.runtime, clock, clock.now + 4 * 60 * MINUTE);
  const rendered = renderDashboard(server.fetch, "/offers/all", fakeEventStream().stream);
  await screen.findByRole("heading", { level: 1, name: "Offers" });
  return { ...rendered, server };
}

const detail = () => within(screen.getByRole("complementary", { name: "Offer details" }));

const TITLE = "Zimmer am Park";

describe("a re-posted room", () => {
  it("is one Offer, with the rent history across its posts", async () => {
    const { user } = await openOffers([
      { adId: 9000001, title: TITLE, warmRent: 450 },
      { adId: 9000002, title: TITLE, warmRent: 480 },
    ]);
    await waitFor(() => expect(titles().filter((t) => /Zimmer am Park/.test(t))).toHaveLength(1));

    await choose(user, "Zimmer am Park");

    await detail().findByRole("heading", { level: 2, name: TITLE });

    const chart = within(detail().getByRole("region", { name: "Rent history" }));
    expect(chart.getByText(/since/).textContent).toMatch(/^\+€ 30 since /);
    const slider = chart.getByRole("slider");
    expect(slider.getAttribute("aria-valuetext")).toBe("€ 480, Today");
    slider.focus();
    await user.keyboard("{Home}");
    expect(slider.getAttribute("aria-valuetext")).toMatch(/^€ 450, /);
  });

  it("takes the later post's title", async () => {
    const { user } = await openOffers([
      { adId: 9000001, title: TITLE, text: ROOM_TEXT },
      { adId: 9000002, title: "Zimmer am Park, renoviert", text: ROOM_TEXT_EDITED },
    ]);
    await choose(user, "Zimmer am Park");
    expect(
      await detail().findByRole("heading", { level: 2, name: "Zimmer am Park, renoviert" }),
    ).toBeTruthy();
    expect(titles().filter((t) => /Zimmer am Park/.test(t))).toHaveLength(1);
  });
});

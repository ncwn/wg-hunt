// @vitest-environment jsdom

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  fakeBatchProvider,
  fakeProvider,
  outputWith,
  sure,
  unsure,
} from "../../../packages/core/src/analysis/testing.js";
import {
  driveCrawl,
  fakeSource,
  MINUTE,
  MORNING,
  offerPageWith,
  relaxCaps,
} from "../../server/test/offers-harness.js";
import { choose, rowOf } from "./offers-page-harness.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

const KEY = "sk-ant-api03-dashboard-test-key-0123456789";

async function openOffer(
  script: Parameters<typeof fakeProvider>[0],
  withKey = true,
  batchScript: Parameters<typeof fakeBatchProvider>[0] = [outputWith({})],
) {
  const fake = fakeProvider(script);
  const batch = fakeBatchProvider(batchScript);
  const source = fakeSource();
  const clock = { now: MORNING };
  const server = realServer({
    fetcher: source.fetcher,
    clock: () => clock.now,
    analysis: {
      providerFor: () => fake.provider,
      batchProviderFor: () => batch.provider,
      sleep: async () => {},
    },
  });
  await server.signIn();
  relaxCaps(server.runtime, clock.now);
  if (withKey) await server.call("PUT", "/secrets/anthropic", { value: KEY });
  source.site.cards = [{ id: 9000001, age: "5 Min.", title: "Zimmer am Park" }];
  source.site.pages.set(9000001, offerPageWith({ title: "Zimmer am Park", warmRent: 450 }));
  await server.call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
  await driveCrawl(server.runtime, clock, clock.now + 4 * 60 * MINUTE);
  await server.runtime.analysis.idle();
  const events = fakeEventStream();
  const rendered = renderDashboard(server.fetch, "/offers/all", events.stream);
  await screen.findByRole("heading", { level: 1, name: "Offers" });
  return { ...rendered, server, events, batch, ...fake };
}

const detail = () => within(screen.getByRole("complementary", { name: "Offer details" }));
const ok = outputWith({ anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") } });

describe("without an Anthropic key", () => {
  it("says the ad waits for a key on the card, not that it is being read, with no tag in the list", async () => {
    const { user } = await openOffer([ok], false);

    const row = await waitFor(() => rowOf("Zimmer am Park"));
    expect(row.textContent).not.toMatch(/Awaiting analysis/);

    await choose(user, "Zimmer am Park");
    expect(await detail().findAllByText(/add an Anthropic API key/)).toHaveLength(1);
    expect(detail().queryByText(/Reading the ad…/)).toBeNull();
    expect(detail().queryByText(/Awaiting analysis/)).toBeNull();
  });

  it("explains why Re-analyse cannot run", async () => {
    const { user } = await openOffer([ok], false);
    await choose(user, "Zimmer am Park");

    await user.click(await detail().findByRole("button", { name: "Re-analyse" }));

    expect((await detail().findByRole("alert")).textContent).toMatch(/Anthropic API key/);
  });
});

describe("with an analysed Offer", () => {
  it("shows the model facts with their origin, and no model names or settings", async () => {
    const { user } = await openOffer([ok]);

    await choose(user, "Zimmer am Park");

    const facts = within(await detail().findByRole("table", { name: "Offer Facts" }));
    const row = facts.getByRole("row", { name: /Anmeldung/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["possible", "Model", "Anmeldung ist möglich", "Override"]);
    expect(detail().queryByText(/claude-haiku-5-5/)).toBeNull();
    expect(detail().queryByText(/Escalation/)).toBeNull();
  });

  it("shows why a fact is Doubtful", async () => {
    const shaky = outputWith({
      anmeldung: { value: "conditional", ...unsure("Anmeldung ist möglich") },
    });
    const { user, server, batch } = await openOffer([shaky], true, [shaky]);
    await server.runtime.analysis.pollBatches();
    batch.complete();
    await server.runtime.analysis.pollBatches();

    await choose(user, "Zimmer am Park");

    const facts = within(await detail().findByRole("table", { name: "Offer Facts" }));
    const row = facts.getByRole("row", { name: /Anmeldung/ });
    expect(row.textContent).toMatch(/Doubtful: the model found the wording ambiguous/);
  });

  it("says the ad is being read while the server reads it, without reading the Offer again", async () => {
    const { user, server, events } = await openOffer([ok]);
    await choose(user, "Zimmer am Park");
    await detail().findByRole("table", { name: "Offer Facts" });
    const id = Number((await (await server.call("GET", "/offers")).json()).items[0].id);

    await events.emit({
      type: "analysis-progress",
      data: {
        offerId: id,
        status: { status: "reading", next: "wait", reason: null, at: null, willRead: true },
        awaiting: 1,
        spentUsd: 0.0002,
      },
    });

    expect(await detail().findByText(/Reading the ad…/)).toBeTruthy();
  });

  it("runs the model again on Re-analyse and shows the new result", async () => {
    const { user, server, requests, events } = await openOffer([
      ok,
      outputWith({
        anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
        requirements: [
          {
            kind: "other",
            strictness: "preferred",
            value: "cooks together",
            ...sure("Wir kochen gern zusammen"),
          },
        ],
      }),
    ]);
    await choose(user, "Zimmer am Park");
    await detail().findByRole("table", { name: "Offer Facts" });

    await user.click(detail().getByRole("button", { name: "Re-analyse" }));
    await server.runtime.analysis.idle();
    await events.emit({
      type: "analysis-progress",
      data: {
        offerId: Number((await (await server.call("GET", "/offers")).json()).items[0].id),
        status: { status: "analyzed", next: "none", reason: null, at: null, willRead: false },
        awaiting: 0,
        spentUsd: 0.0004,
      },
    });

    expect(requests).toHaveLength(2);
    await waitFor(() => expect(detail().getByRole("row", { name: /Requirements/ })).toBeTruthy());
  });
});

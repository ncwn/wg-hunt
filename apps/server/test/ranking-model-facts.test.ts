import { emptyOutput, fakeProvider, outputWith, sure } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { bootOffers } from "./offers-harness.js";

const KEY = "sk-ant-api03-test-key-do-not-leak-0123456789";

async function bootNeedingAnmeldung(anmeldung: "possible" | "not_possible" | null) {
  const fake = fakeProvider([
    anmeldung === null
      ? emptyOutput()
      : outputWith({ anmeldung: { value: anmeldung, ...sure("Anmeldung ist möglich") } }),
  ]);
  const h = bootOffers({ analysis: { providerFor: () => fake.provider, sleep: async () => {} } });
  await h.call("PUT", "/secrets/anthropic", { value: KEY });
  const profile = (await h.json("GET", "/profile")).body;
  await h.json("PUT", "/profile", { ...profile, anmeldungNeeded: true });
  h.site.cards = h.freshCards([9000001]);
  await h.addSearch();
  await h.crawl();
  await h.runtime.analysis.idle();
  return h;
}

const listed = async (h: Awaited<ReturnType<typeof bootNeedingAnmeldung>>) =>
  (await h.json("GET", "/offers?includeHidden=true")).body.items[0];

describe("ranking reads the model's facts beside the rule facts", () => {
  it("makes a Match of an Offer whose analysed Anmeldung is possible", async () => {
    const h = await bootNeedingAnmeldung("possible");
    expect(await listed(h)).toMatchObject({
      band: "match",
      reasons: [expect.objectContaining({ filter: "anmeldung", outcome: "pass" })],
    });
  });

  it("hides an Offer whose analysed Anmeldung is not possible", async () => {
    const h = await bootNeedingAnmeldung("not_possible");
    expect(await listed(h)).toMatchObject({
      band: "hidden",
      reasons: [
        expect.objectContaining({ filter: "anmeldung", outcome: "fail", effect: "hidden" }),
      ],
    });
  });

  it("keeps an Offer the model could not decide on in Near match", async () => {
    const h = await bootNeedingAnmeldung(null);
    expect(await listed(h)).toMatchObject({
      band: "near-match",
      reasons: [expect.objectContaining({ filter: "anmeldung", cause: "unknown" })],
    });
  });

  it("re-bands the Offer when the analysis finishes, and says so on /events", async () => {
    const h = await bootNeedingAnmeldung("possible");
    const moved = h.events.filter((event) => event.type === "offer-band-changed");
    expect(moved.map((event) => event.data)).toEqual([
      expect.objectContaining({ previousBand: "near-match", band: "match" }),
    ]);
  });
});

import { emptyOutput, fakeProvider, outputWith, sure } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { adPage, hash, ingestAds, OTHER_ROOM_TEXT, ROOM_TEXT } from "./dedupe-harness.js";
import { bootOffers } from "./offers-harness.js";

const KEY = "sk-ant-api03-test-key-do-not-leak-0123456789";

type Harness = ReturnType<typeof bootOffers>;
type Signal = { kind: string; quote?: string };

const WESTERN_UNION = "Die Kaution bitte vorab per Western Union überweisen.";
const WHATSAPP = "Schreib mir bitte nur auf WhatsApp.";
const ID_COPY = "Bitte schick mir vorab eine Kopie deines Ausweises.";
const KEYS = "Die Übergabe läuft über den Zoll, die Schlüssel kommen per Post.";

async function bootAnalysed(text: string, signals: { kind: string; quote: string }[]) {
  const fake = fakeProvider([
    signals.length === 0
      ? emptyOutput()
      : outputWith({
          scamSignals: signals.map(
            (signal) => ({ kind: signal.kind, ...sure(signal.quote) }) as never,
          ),
        }),
  ]);
  const h = bootOffers({ analysis: { providerFor: () => fake.provider, sleep: async () => {} } });
  await h.call("PUT", "/secrets/anthropic", { value: KEY });
  h.site.cards = h.freshCards([9000001]);
  h.site.pages.set(9000001, adPage({ adId: 9000001, text: `${ROOM_TEXT} ${text}` }));
  await h.addSearch();
  await h.crawl();
  await h.runtime.analysis.idle();
  const { body } = await h.json("GET", "/offers");
  return { h, id: body.items[0].id as number };
}

const detail = async (h: Harness, id: number) => (await h.json("GET", `/offers/${id}`)).body;
const listed = async (h: Harness) =>
  (await h.json("GET", "/offers?includeHidden=true")).body.items[0];
const mark = (h: Harness, id: number, scam: "scam" | "not" | "clear") =>
  h.json("PATCH", `/offers/${id}/marks`, { scam });

describe("text signals put an Offer in Warned", () => {
  it("one strong signal makes a Likely scam, with its quote, and Warned", async () => {
    const { h, id } = await bootAnalysed(WESTERN_UNION, [
      { kind: "money_before_viewing", quote: WESTERN_UNION },
    ]);
    const offer = await detail(h, id);
    expect(offer.band).toBe("warned");
    expect(offer.scam).toMatchObject({
      likelyScam: true,
      computedLikelyScam: true,
      mark: null,
      strong: 1,
      soft: 0,
      signals: [
        {
          kind: "money_before_viewing",
          strength: "strong",
          origin: "text",
          quote: WESTERN_UNION,
          doubtful: false,
        },
      ],
    });
    expect((await listed(h)).band).toBe("warned");
  });

  it("two soft signals are only caution chips, three are a Likely scam", async () => {
    const { h, id } = await bootAnalysed(`${WHATSAPP} ${ID_COPY}`, [
      { kind: "off_platform_contact", quote: WHATSAPP },
      { kind: "id_copy_upfront", quote: ID_COPY },
    ]);
    const offer = await detail(h, id);
    expect(offer.band).not.toBe("warned");
    expect(offer.scam).toMatchObject({ likelyScam: false, soft: 2 });
    expect(offer.chips.filter((chip: { kind: string }) => chip.kind === "scam-caution")).toEqual([
      expect.objectContaining({ tone: "warn", quote: WHATSAPP }),
      expect.objectContaining({ tone: "warn", quote: ID_COPY }),
    ]);

    const three = await bootAnalysed(`${WHATSAPP} ${ID_COPY} ${KEYS}`, [
      { kind: "off_platform_contact", quote: WHATSAPP },
      { kind: "id_copy_upfront", quote: ID_COPY },
      { kind: "deposit_over_three_months", quote: KEYS },
    ]);
    expect((await detail(three.h, three.id)).band).toBe("warned");
  });

  it("reasons a Doubtful signal as soft: a quote the Offer does not contain cannot warn alone", async () => {
    const { h, id } = await bootAnalysed("Alles ganz normal.", [
      { kind: "keys_by_post", quote: "Die Schlüssel kommen per Post" },
    ]);
    const offer = await detail(h, id);
    expect(offer.band).not.toBe("warned");
  });
});

describe("hide likely scams", () => {
  it("moves a Warned Offer to Hidden when turned on, and back when turned off", async () => {
    const { h, id } = await bootAnalysed(WESTERN_UNION, [
      { kind: "money_before_viewing", quote: WESTERN_UNION },
    ]);
    const filters = (await h.json("GET", "/filters")).body;
    expect(filters.hideLikelyScams.enabled).toBe(false);

    await h.json("PUT", "/filters", {
      ...filters,
      hideLikelyScams: { enabled: true, strength: "dealbreaker" },
    });
    const hidden = await detail(h, id);
    expect(hidden.band).toBe("hidden");
    expect(hidden.reasons).toContainEqual(
      expect.objectContaining({ filter: "hideLikelyScams", effect: "hidden" }),
    );

    await h.json("PUT", "/filters", filters);
    expect((await detail(h, id)).band).toBe("warned");
  });
});

describe("PATCH /offers/{id}/marks: the seeker's scam mark", () => {
  const strong = [{ kind: "keys_by_post", quote: KEYS }];

  it("'not' lifts a computed Likely scam out of Warned and 'clear' restores it", async () => {
    const { h, id } = await bootAnalysed(KEYS, strong);
    expect((await detail(h, id)).band).toBe("warned");

    const marked = await mark(h, id, "not");
    expect(marked.status).toBe(200);
    expect(marked.body.band).not.toBe("warned");
    expect(marked.body.scam).toMatchObject({
      mark: "not",
      likelyScam: false,
      computedLikelyScam: true,
    });
    expect(marked.body.scam.signals).toHaveLength(1);

    const cleared = await mark(h, id, "clear");
    expect(cleared.body.band).toBe("warned");
    expect(cleared.body.scam).toMatchObject({ mark: null, likelyScam: true });
  });

  it("'scam' warns about an Offer with no signals", async () => {
    const { h, id } = await bootAnalysed("", []);
    expect((await detail(h, id)).scam).toMatchObject({ likelyScam: false, signals: [] });
    const marked = await mark(h, id, "scam");
    expect(marked.body.band).toBe("warned");
    expect(marked.body.scam).toMatchObject({ mark: "scam", likelyScam: true, signals: [] });
  });

  it("re-bands at once and says so on /events", async () => {
    const { h, id } = await bootAnalysed(KEYS, strong);
    const before = h.events.length;
    await mark(h, id, "not");
    expect(h.events.slice(before).map((event) => event.type)).toContain("offer-band-changed");
  });

  it("is remembered across a fresh read, and hide likely scams hides a marked scam", async () => {
    const { h, id } = await bootAnalysed("", []);
    await mark(h, id, "scam");
    expect((await listed(h)).band).toBe("warned");
    const filters = (await h.json("GET", "/filters")).body;
    await h.json("PUT", "/filters", {
      ...filters,
      hideLikelyScams: { enabled: true, strength: "dealbreaker" },
    });
    expect((await detail(h, id)).band).toBe("hidden");
  });

  it("answers not-found for an unknown Offer and a validation problem for a bad mark", async () => {
    const { h, id } = await bootAnalysed("", []);
    expect((await mark(h, 99999, "scam")).status).toBe(404);
    expect((await h.json("PATCH", `/offers/${id}/marks`, { scam: "maybe" })).status).toBe(400);
  });
});

describe("derived signals", () => {
  const signalsOf = async (h: Harness, adId: number): Promise<Signal[]> =>
    (await h.json("GET", `/offers/lookup?adId=${adId}`)).body.scam.signals;

  it("flags a new unverified account, with the Offer's own words", async () => {
    const h = bootOffers();
    ingestAds(h, {
      adId: 9000001,
      advertiser: { name: "Anna", memberSince: "Oktober 2026", verified: false },
    });
    expect(await signalsOf(h, 9000001)).toEqual([
      expect.objectContaining({
        kind: "new_unverified_account",
        strength: "soft",
        origin: "derived",
        quote: "Mitglied seit Oktober 2026",
      }),
    ]);
  });

  it("never flags a Verifiziert or a company Advertiser", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001, advertiser: { name: "Anna", memberSince: "Oktober 2026" } },
      {
        adId: 9000002,
        street: "Andere Straße 4",
        images: [hash(41), hash(42), hash(43)],
        text: OTHER_ROOM_TEXT,
        advertiser: {
          name: "Verwaltung GmbH",
          memberSince: "Oktober 2026",
          company: true,
          verified: false,
        },
      },
    );
    expect(await signalsOf(h, 9000001)).toEqual([]);
    expect(await signalsOf(h, 9000002)).toEqual([]);
  });

  describe("Cloned offer", () => {
    const original = { name: "Anna", memberSince: "Mai 2020" };
    const copier = (extra: { verified?: boolean; memberSince?: string }) => ({
      name: "Marek",
      memberSince: "Oktober 2026",
      ...extra,
    });

    it("is strong when the copier joined later and is not Verifiziert", async () => {
      const h = bootOffers();
      ingestAds(
        h,
        { adId: 9000001, advertiser: original },
        { adId: 9000002, advertiser: copier({ verified: false }) },
      );
      const offer = (await h.json("GET", "/offers/lookup?adId=9000002")).body;
      expect(offer.scam.likelyScam).toBe(true);
      expect(offer.scam.signals.find((s: Signal) => s.kind === "cloned_offer")).toMatchObject({
        strength: "strong",
        origin: "derived",
        evidence: expect.stringContaining(`Offer ${offer.cloned[0].offer.id}`),
      });
    });

    it("is soft when the copier is Verifiziert, and the original gets no signal", async () => {
      const h = bootOffers();
      ingestAds(
        h,
        { adId: 9000001, advertiser: original },
        { adId: 9000002, advertiser: copier({ verified: true }) },
      );
      const copy = (await h.json("GET", "/offers/lookup?adId=9000002")).body;
      expect(copy.scam.signals).toEqual([
        expect.objectContaining({ kind: "cloned_offer", strength: "soft" }),
      ]);
      expect(copy.scam.likelyScam).toBe(false);
      expect(await signalsOf(h, 9000001)).toEqual([]);
    });
  });

  describe("rent below the district median", () => {
    async function bootMarket(others: number, rent: number) {
      const h = bootOffers();
      const flats = Array.from({ length: others }, (_, index) => ({
        adId: 9100000 + index,
        street: `Marktstraße ${index + 1}`,
        images: [hash(1000 + index * 3), hash(1001 + index * 3), hash(1002 + index * 3)],
      }));
      ingestAds(h, ...flats, {
        adId: 9000001,
        warmRent: rent,
        street: "Billigweg 1",
        images: [hash(1), hash(2), hash(3)],
      });
      return (await h.json("GET", "/offers/lookup?adId=9000001")).body;
    }

    it("fires under 60% of the median of 15 comparable Offers, showing the baseline", async () => {
      const offer = await bootMarket(15, 150);
      const signal = offer.scam.signals.find((s: Signal) => s.kind === "rent_below_median");
      expect(signal).toMatchObject({ strength: "soft", origin: "derived" });
      expect(signal.evidence).toContain("district median €27.17/m² from 15 Offers");
    });

    it("stays silent with only 14 comparable Offers", async () => {
      const offer = await bootMarket(14, 150);
      expect(offer.scam.signals).toEqual([]);
    });

    it("stays silent for a rent that is not under 60%", async () => {
      const offer = await bootMarket(15, 400);
      expect(offer.scam.signals).toEqual([]);
    });
  });
});

describe("a mark survives joining two Offers", () => {
  it("keeps the mark the seeker set on the absorbed Offer", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001, street: "Erststraße 1", images: [hash(11), hash(12), hash(13)] },
      {
        adId: 9000002,
        street: "Zweitstraße 2",
        text: OTHER_ROOM_TEXT,
        images: [hash(21), hash(22), hash(23)],
      },
    );
    const [first, second] = await Promise.all(
      [9000001, 9000002].map(
        async (adId) => (await h.json("GET", `/offers/lookup?adId=${adId}`)).body,
      ),
    );
    await mark(h, second.id, "scam");

    const joined = await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });
    expect(joined.status).toBe(200);
    expect(joined.body.scam).toMatchObject({ mark: "scam", likelyScam: true });
  });
});

import { describe, expect, it } from "vitest";
import { euros, moveInDay, rowReasons, toOfferRow } from "../src/offer-rows.js";
import type { OfferSummary } from "../src/offers.js";

const NOW = new Date(2026, 10, 7, 12);

function summary(change: Partial<OfferSummary> = {}): OfferSummary {
  return {
    id: 7,
    category: "flatshare-room",
    title: "Bright room near Görlitzer Park",
    url: "https://www.wg-gesucht.de/7.html",
    firstSeenAt: "2026-11-07T08:00:00Z",
    createdAt: "2026-11-07T08:00:00Z",
    updatedAt: "2026-11-07T08:00:00Z",
    lastBumpAt: null,
    pageStatus: "active",
    stale: false,
    tracked: true,
    analysisState: "analyzed",
    analysisStatus: { status: "analyzed", next: "none", reason: null, at: null, willRead: false },
    band: "near-match",
    bandChangedAt: "2026-11-07T08:00:00Z",
    reasons: [],
    chips: [],
    hiddenBecause: null,
    visibility: { hidden: [], actions: { recheck: true, undismiss: false } },
    marks: { dismissed: false, shortlisted: true, contacted: false, scam: null },
    distance: null,
    keyFacts: {
      warmRent: { amount: 590, converted: false },
      size: 16,
      district: "Kreuzberg",
      availableFrom: "2026-12-01",
    },
    ...change,
  } as OfferSummary;
}

describe("offer rows", () => {
  it("formats an Offer the way people say it", () => {
    expect(toOfferRow(summary(), { lastSeen: null, now: NOW })).toEqual({
      id: 7,
      title: "Bright room near Görlitzer Park",
      band: "near",
      isNew: true,
      shortlisted: true,
      district: "Kreuzberg",
      rent: "€ 590",
      size: "16 m²",
      moveIn: "1 Dec",
    });
  });

  it("flags a rent without its costs, and leaves unknown facts out", () => {
    const row = toOfferRow(
      summary({
        chips: [{ kind: "costs-incomplete", tone: "warn", label: "Costs incomplete" }],
        keyFacts: {
          warmRent: { amount: 480, converted: false },
          size: null,
          district: null,
          availableFrom: null,
        },
      }),
      { lastSeen: Date.parse("2026-11-07T09:00:00Z"), now: NOW },
    );
    expect(row.rentNote).toBe("costs not stated");
    expect(row.isNew).toBe(false);
    expect(row).not.toHaveProperty("size");
    expect(row).not.toHaveProperty("district");
  });

  it("says Now for a move-in day that has come, and adds the year outside this one", () => {
    expect(moveInDay("2026-11-01", NOW)).toBe("Now");
    expect(moveInDay("2027-01-15", NOW)).toBe("15 Jan 2027");
    expect(euros(612.4)).toBe("€ 612");
  });

  it("keeps reasons short and leaves out what the row already shows", () => {
    expect(
      rowReasons([
        {
          filter: "maxRent",
          strength: "dealbreaker",
          outcome: "pass",
          effect: "none",
          cause: "met",
          message: "Fits",
        },
        {
          filter: "anmeldung",
          strength: "want",
          outcome: "warn",
          effect: "near-match",
          cause: "unknown",
          message: "?",
          quote: "Anmeldung?",
        },
      ]),
    ).toEqual([{ outcome: "warn", text: "Anmeldung", quote: "Anmeldung?" }]);
  });

  it("keeps a rent or size chip when it is the concern", () => {
    const reason = (filter: string, outcome: "pass" | "warn" | "fail") => ({
      filter,
      strength: "dealbreaker" as const,
      outcome,
      effect: "none" as const,
      cause: "met" as const,
      message: "",
    });
    expect(
      rowReasons([
        reason("maxRent", "fail"),
        reason("minSize", "warn"),
        reason("maxRentPerSqm", "pass"),
      ] as Parameters<typeof rowReasons>[0]),
    ).toEqual([
      { outcome: "fail", text: "Warm rent" },
      { outcome: "warn", text: "Size" },
    ]);
  });
});

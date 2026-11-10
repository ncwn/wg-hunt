import { describe, expect, it } from "vitest";
import { compareKeys, orderKey, type Sort } from "./order.js";
import { rankOffer } from "./rank.js";
import { DAY, fact, NOW, offer, seeking } from "./test-helpers.js";

type Spec = {
  name: string;
  facts?: Record<string, unknown>;
  bumped?: number;
  firstSeen?: number;
  stale?: boolean;
  likelyScam?: boolean;
};

const rent = (amount: number) => fact({ amount, converted: false });

function order(specs: Spec[], sort: Sort = "recency", profile = {}, filters = {}) {
  const config = seeking(profile, filters);
  return specs
    .map((spec) => {
      const o = offer(spec.facts, {
        firstSeenAt: spec.firstSeen ?? NOW - 10 * DAY,
        lastBumpAt: spec.bumped ?? null,
        stale: spec.stale,
        scam: spec.likelyScam ? { likelyScam: true, cautions: [] } : undefined,
      });
      return { spec, key: orderKey(o, rankOffer(o, config), sort, config) };
    })
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ spec }) => spec.name);
}

describe("order within the bands", () => {
  const profile = { age: 30 };

  it("lists the bands in order: Match, Near match, Warned, Hidden", () => {
    const names = order(
      [
        { name: "hidden", stale: true },
        { name: "warned", likelyScam: true },
        { name: "near", facts: { ageSought: fact({ min: 40 }) } },
        { name: "match", facts: { ageSought: fact({ min: 20 }) } },
      ],
      "recency",
      profile,
    );
    expect(names).toEqual(["match", "near", "warned", "hidden"]);
  });

  it("sorts a Match by the last Bump, newest first", () => {
    expect(
      order([
        { name: "old", bumped: NOW - 3 * DAY },
        { name: "new", bumped: NOW - 1 * DAY },
      ]),
    ).toEqual(["new", "old"]);
  });

  it("falls back to first seen when there is no Bump", () => {
    expect(
      order([
        { name: "bumped", bumped: NOW - 5 * DAY },
        { name: "seen", firstSeen: NOW - 1 * DAY },
      ]),
    ).toEqual(["seen", "bumped"]);
  });

  it("sorts a Near match by fewest misses, then recency", () => {
    const miss = { ageSought: fact({ min: 40 }), genderSought: fact("any") };
    const twoMisses = { ...miss, genderSought: fact("unknown") };
    const names = order(
      [
        { name: "two-new", facts: twoMisses, bumped: NOW - 1 * DAY },
        { name: "one-old", facts: miss, bumped: NOW - 4 * DAY },
        { name: "one-new", facts: miss, bumped: NOW - 2 * DAY },
      ],
      "recency",
      { age: 30, gender: "woman" },
    );
    expect(names).toEqual(["one-new", "one-old", "two-new"]);
  });
});

describe("switching the sort", () => {
  const specs: Spec[] = [
    {
      name: "mid",
      facts: {
        warmRent: rent(500),
        rentPerSqm: fact(25),
        roomSize: fact(20),
        availableFrom: fact("2027-02-01"),
      },
      bumped: NOW - 2 * DAY,
    },
    {
      name: "cheap",
      facts: {
        warmRent: rent(400),
        rentPerSqm: fact(30),
        roomSize: fact(13),
        availableFrom: fact("2027-03-01"),
      },
      bumped: NOW - 3 * DAY,
    },
    {
      name: "big",
      facts: {
        warmRent: rent(900),
        rentPerSqm: fact(18),
        roomSize: fact(50),
        availableFrom: fact("2027-01-01"),
      },
      bumped: NOW - 4 * DAY,
    },
    { name: "blank", facts: {}, bumped: NOW - 1 * DAY },
  ];

  it.each([
    ["warm-rent", ["cheap", "mid", "big", "blank"]],
    ["rent-per-sqm", ["big", "mid", "cheap", "blank"]],
    ["size", ["big", "mid", "cheap", "blank"]],
    ["available-from", ["big", "mid", "cheap", "blank"]],
  ] as const)("by %s, with unknown values last", (sort, expected) => {
    expect(order(specs, sort)).toEqual(expected);
  });

  it("still keeps the bands apart", () => {
    const names = order(
      [
        { name: "cheap-hidden", facts: { warmRent: rent(100) }, stale: true },
        { name: "dear-match", facts: { warmRent: rent(900) } },
      ],
      "warm-rent",
    );
    expect(names).toEqual(["dear-match", "cheap-hidden"]);
  });

  it("breaks a tie by recency", () => {
    const names = order(
      [
        { name: "older", facts: { warmRent: rent(500) }, bumped: NOW - 3 * DAY },
        { name: "newer", facts: { warmRent: rent(500) }, bumped: NOW - 1 * DAY },
      ],
      "warm-rent",
    );
    expect(names).toEqual(["newer", "older"]);
  });
});

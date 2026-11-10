import { describe, expect, it } from "vitest";
import type { PairCase } from "./cases.js";
import { runDedupe } from "./dedupe-run.js";
import { renderPage } from "./synthetic-page.js";

const ROOM_TEXT =
  "Das Zimmer ist hell und möbliert, es hat einen großen Balkon zur Südseite und einen Parkettboden. " +
  "Die Küche teilen wir uns mit zwei Mitbewohnern, die Waschmaschine steht im Bad. " +
  "Fahrräder können im Keller abgestellt werden und das Internet ist im Preis enthalten.";

const photos = (adId: string, ...names: string[]) =>
  names.map((name, i) => ({ digest: `${adId}${i}`, name }));
const R1 = "IMG_20261020_101504";
const R2 = "IMG_20261020_101532";

function page(adId: string, images: { digest: string; name: string }[]) {
  return renderPage({
    adId,
    title: "Zimmer in Beispiel-WG",
    category: "flatshare-room",
    flatmates: { code: "1w,2m,0d,0n", size: 4 },
    roomSize: 16,
    flatSize: 70,
    totalRent: { euros: 480 },
    street: "Beispielweg 3",
    postalCode: "54321",
    sections: [["Zimmer", ROOM_TEXT]],
    advertiser: { since: "Oktober 2026" },
    images,
  });
}

const anna = { name: "Anna", kind: "private" as const };
const bob = { name: "Bob", kind: "private" as const };

const pair = (id: string, expected: PairCase["expected"], b: PairCase["b"]): PairCase => ({
  id,
  category: "flatshare-room",
  expected,
  a: { html: page("9200001", photos("9200001", R1, R2)), advertiser: anna },
  b,
});

describe("running the dedupe rules over labelled pairs", () => {
  it("compares the pages as the server does and reports precision and recall", () => {
    const metrics = runDedupe([
      pair("repost", "duplicate", {
        html: page("9200002", photos("9200002", R1, R2)),
        advertiser: anna,
      }),
      pair("copied", "cloned", { html: page("9200003", photos("9200003", R1)), advertiser: bob }),
      pair("mislabelled", "duplicate", {
        html: page("9200004", photos("9200004", R1)),
        advertiser: bob,
      }),
    ]);
    expect(metrics.pairs).toBe(3);
    expect(metrics.relations.duplicate).toMatchObject({ truePositives: 1, falseNegatives: 1 });
    expect(metrics.relations.cloned).toMatchObject({ truePositives: 1, falsePositives: 1 });
    expect(metrics.misses).toEqual([
      { id: "mislabelled", expected: "duplicate", actual: "cloned" },
    ]);
  });

  it("stops at a page the adapter cannot read, naming the pair", () => {
    expect(() =>
      runDedupe([pair("broken", "apart", { html: "<html></html>", advertiser: anna })]),
    ).toThrow(/broken/);
  });
});

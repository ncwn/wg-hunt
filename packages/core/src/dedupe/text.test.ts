import { describe, expect, it } from "vitest";
import { textSignature, textSimilarity } from "./text.js";

const ROOM =
  "Das Zimmer ist hell und möbliert, es hat einen großen Balkon zur Südseite und einen Parkettboden. " +
  "Die Küche teilen wir uns mit zwei Mitbewohnern, die Waschmaschine steht im Bad. " +
  "Fahrräder können im Keller abgestellt werden und das Internet ist im Preis enthalten.";

const similarity = (a: string, b: string) => {
  const left = textSignature(a);
  const right = textSignature(b);
  if (left === null || right === null) throw new Error("text too short to compare");
  return textSimilarity(left, right);
};

describe("text similarity", () => {
  it("treats the same words as identical, whatever the case, spacing or punctuation", () => {
    const reshaped = ROOM.replace("Das Zimmer ist hell", "DAS ZIMMER IST HELL")
      .replaceAll(",", " , ")
      .replaceAll(". ", ".\n");
    expect(similarity(ROOM, reshaped)).toBe(1);
  });

  it("stays high when a re-post changes a few words", () => {
    const edited = ROOM.replace("hell und möbliert", "freundlich und möbliert").replace(
      "zwei Mitbewohnern",
      "drei Mitbewohnern",
    );
    expect(similarity(ROOM, edited)).toBeGreaterThan(0.6);
    expect(similarity(ROOM, edited)).toBeLessThan(1);
  });

  it("is near zero for unrelated texts", () => {
    const other =
      "Wir suchen zum ersten Dezember eine ruhige Mitbewohnerin für unsere Dreier-Wohngemeinschaft " +
      "in der Nähe des Bahnhofs, die gern kocht und ihre Abende lieber gemeinsam auf dem Sofa verbringt.";
    expect(similarity(ROOM, other)).toBeLessThan(0.1);
  });

  it("has no signature for a text too short to compare", () => {
    expect(textSignature("Zimmer frei, bitte melden.")).toBeNull();
    expect(textSignature("")).toBeNull();
  });

  it("survives being stored as JSON", () => {
    const signature = textSignature(ROOM);
    if (signature === null) throw new Error("expected a signature");
    expect(JSON.parse(JSON.stringify(signature))).toEqual(signature);
  });
});

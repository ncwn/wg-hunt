import { describe, expect, it } from "vitest";
import { offer } from "./testing.js";

/**
 * The live site puts a label and its value in separate columns of a row, with whitespace and a
 * hidden colon around them, and the address in one element split by a line break.
 */
describe("the live site's layout", () => {
  const compact = offer("flatshare");
  const live = offer("flatshare-live-layout");

  it.each([
    "roomSize",
    "warmRent",
    "baseRent",
    "utilities",
    "otherCosts",
    "deposit",
    "rentPerSqm",
    "costsComplete",
    "schufaRequested",
    "availableFrom",
    "availableUntil",
    "street",
    "postalCode",
    "district",
  ])("reads %s as the compact layout does", (key) => {
    expect(live.facts[key as keyof typeof live.facts]).toEqual(
      compact.facts[key as keyof typeof compact.facts],
    );
  });

  it("reads the time since the last publish", () => {
    expect(live.online).toEqual(compact.online);
  });
});

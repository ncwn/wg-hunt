import { type Fact, UNKNOWN } from "../../offer-facts/index.js";

export function field<V>(value: V, quote: string): Fact<V> {
  return { value, origin: "field", quote };
}

/** A quote is given when the page shows the field but its value does not read, as with "n.a.". */
export function unknown(quote = ""): Fact<never> {
  return { value: UNKNOWN, origin: "field", quote };
}

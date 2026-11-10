import type { LookupFunction } from "node:net";
import { connect } from "node:net";
import { expect, it } from "vitest";

const lookup = ((_host: string, _options: unknown, done: (error: Error) => void) => {
  done(new Error("no lookups in this test"));
}) as LookupFunction;

it.fails("fails a test whose attempt product code swallowed, without the test importing the guard", () => {
  try {
    connect({ host: "wg-hunt.example.test", port: 80, lookup }).on("error", () => {});
  } catch {}
  expect(true).toBe(true);
});

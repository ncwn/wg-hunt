import { createServer, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { failOnAttempts, isThisMachine, takeAttempts } from "./no-network.js";

const RULE = /^No network in tests/;

describe("no network in tests", () => {
  afterEach(() => {
    takeAttempts();
  });

  it("refuses a connection to another machine through net, tls and fetch, naming the rule", async () => {
    expect(() => connect(443, "wg-hunt.example.test")).toThrow(RULE);
    expect(() => connect({ host: "wg-hunt.example.test", port: 80 })).toThrow(RULE);
    expect(() => tlsConnect({ host: "wg-hunt.example.test", port: 443 })).toThrow(RULE);
    const error = await fetch("https://wg-hunt.example.test/v1/messages").catch((e: unknown) => e);
    expect(((error as Error).cause as Error).message).toMatch(RULE);
    expect(takeAttempts()).toEqual([
      "wg-hunt.example.test:443",
      "wg-hunt.example.test:80",
      "wg-hunt.example.test:443",
      "wg-hunt.example.test:443",
    ]);
  });

  const looked: string[] = [];
  const lookup = ((host: string, _options: unknown, done: (error: Error) => void) => {
    looked.push(host);
    done(new Error("no lookups in this test"));
  }) as LookupFunction;

  it("refuses another machine through node:http and node:https before any lookup", async () => {
    const refusal = (send: () => { on(event: "error", listener: (e: Error) => void): unknown }) =>
      new Promise<string>((resolve) => {
        try {
          send().on("error", (error) => resolve(error.message));
        } catch (error) {
          resolve((error as Error).message);
        }
      });
    expect(await refusal(() => httpGet("http://wg-hunt.example.test/x", { lookup }))).toMatch(RULE);
    expect(await refusal(() => httpsGet("https://wg-hunt.example.test/x", { lookup }))).toMatch(
      RULE,
    );
    expect(looked).toEqual([]);
    expect(takeAttempts()).toEqual(["wg-hunt.example.test:80", "wg-hunt.example.test:443"]);
  });

  it("checks the host unless the path names a socket file, as Node decides", async () => {
    for (const path of [null, undefined, ""]) {
      const options = { path, host: "wg-hunt.example.test", port: 80, lookup };
      expect(() => connect(options as never).on("error", () => {})).toThrow(RULE);
    }
    expect(looked).toEqual([]);
    expect(takeAttempts()).toHaveLength(3);
    const socket = connect({
      path: join(tmpdir(), "wg-hunt-no-such.sock"),
      host: "wg-hunt.example.test",
      port: 80,
    } as never);
    await new Promise((resolve) => socket.on("error", resolve));
    expect(takeAttempts()).toEqual([]);
  });

  it("fails the test for an attempt that product code swallowed, once", () => {
    try {
      connect({ host: "wg-hunt.example.test", port: 80, lookup });
    } catch {}
    expect(() => failOnAttempts()).toThrow(
      /^No network in tests: a test opened a connection to wg-hunt\.example\.test:80\./,
    );
    expect(() => failOnAttempts()).not.toThrow();
  });

  it("lets a test reach a server on this machine", async () => {
    const server = createServer((_, res) => res.end("here"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("here");
    } finally {
      server.close();
    }
    expect(takeAttempts()).toEqual([]);
  });

  it("takes only this machine as this machine", () => {
    for (const here of [
      undefined,
      "",
      "localhost",
      "LocalHost",
      "wg-hunt.localhost",
      "::1",
      "[::1]",
      "127.0.0.1",
      "127.1.2.3",
    ]) {
      expect(isThisMachine(here), String(here)).toBe(true);
    }
    for (const elsewhere of [
      "wg-hunt.example.test",
      "localhost.example.test",
      "127.0.0.1.example.test",
      "128.0.0.1",
      "10.0.0.1",
      "0.0.0.0",
      "2001:db8::1",
      "::ffff:7f00:1",
    ]) {
      expect(isThisMachine(elsewhere), elsewhere).toBe(false);
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { fakeProviders } from "../../../packages/core/src/analysis/testing.js";
import type { AnalysisOptions } from "../../server/src/analysis/worker.js";
import type { SourceFetcher } from "../../server/src/crawl/fetcher.js";
import { startRuntime } from "../../server/src/runtime.js";

const ORIGIN = "http://localhost";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});

export function realServer({
  signedIn = false,
  fetcher,
  clock,
  analysis,
}: {
  signedIn?: boolean;
  fetcher?: SourceFetcher;
  /** Epoch milliseconds. */
  clock?: () => number;
  analysis?: AnalysisOptions;
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wg-hunt-dashboard-"));
  const runtime = startRuntime(
    { dataDir, port: 0, host: "127.0.0.1" },
    process.cwd(),
    [],
    fetcher,
    clock,
    () => 0.5,
    { ...fakeProviders(), ...analysis },
  );
  cleanups.push(() => {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  let cookie = "";
  const fetch = async (request: Request) => {
    const headers = new Headers(request.headers);
    headers.set("Origin", ORIGIN);
    if (cookie) headers.set("Cookie", cookie);
    const response = await runtime.app.request(new Request(request, { headers }));
    const set = response.headers.get("set-cookie");
    if (set) cookie = /Max-Age=0/i.test(set) ? "" : (set.split(";")[0] ?? "");
    return response;
  };

  async function signIn() {
    await fetch(
      new Request(`${ORIGIN}/api/v1/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: runtime.token }),
      }),
    );
  }

  async function call(method: string, path: string, body?: unknown) {
    return fetch(
      new Request(`${ORIGIN}/api/v1${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
  }

  const asCli = (path: string, init: RequestInit = {}) =>
    runtime.app.request(`/api/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtime.token}`,
        ...init.headers,
      },
    });

  const ready = signedIn ? signIn() : Promise.resolve();

  return {
    runtime,
    fetch,
    asCli,
    ready,
    signIn,
    call,
    get token() {
      return runtime.token;
    },
  };
}

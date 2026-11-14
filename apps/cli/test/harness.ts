import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach } from "vitest";
import { bootOffers, MINUTE, offerPageWith } from "../../server/test/offers-harness.js";
import type { Io } from "../src/io.js";
import type { Problem } from "../src/problem.js";
import { run } from "../src/run.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wg-hunt-cli-"));
  dirs.push(dir);
  return dir;
}

setFlagsFromString("--expose-gc");
export const collectGarbage = runInNewContext("gc") as () => void;

export type Result = { code: number; stdout: string; stderr: string };

export function problemOf({ code, stderr }: Result): Problem {
  for (const text of [stderr, stderr.trimEnd().split("\n").at(-1) ?? ""]) {
    try {
      const value: unknown = JSON.parse(text);
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as Problem).type === "string" &&
        typeof (value as Problem).title === "string"
      ) {
        return value as Problem;
      }
    } catch {
      // Not JSON as a whole: the problem may still be the last line.
    }
  }
  throw new Error(`exit ${code} left no problem at the end of stderr:\n${stderr || "(nothing)"}`);
}

export type Ad = { id: number; title: string; warmRent: number };

const THREE: Ad[] = [
  { id: 9000001, title: "Cheap room", warmRent: 450 },
  { id: 9000002, title: "Dear room", warmRent: 520 },
  { id: 9000003, title: "Dearest room", warmRent: 700 },
];

export type Server = ReturnType<typeof bootOffers>;

export async function serverWith(ads: Ad[] = THREE): Promise<Server> {
  const server = bootOffers();
  server.site.cards = ads.map(({ id, title }) => ({ id, age: "5 Min.", title }));
  for (const ad of ads) server.site.pages.set(ad.id, offerPageWith(ad));
  await server.addSearch();
  await server.crawl(4 * 60 * MINUTE);
  return server;
}

export async function limitRent(server: Server): Promise<void> {
  const filters = (await server.json("GET", "/filters")).body;
  filters.maxRent.enabled = true;
  filters.maxRent.limit = 500;
  filters.maxRent.margin = { value: 50, unit: "absolute" };
  await server.json("PUT", "/filters", filters);
}

export type CliOptions = {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  cwd?: string;
  /** `null` makes it a terminal. */
  stdin?: string | null;
  prompt?: (label: string) => string;
  fetch?: Io["fetch"];
  stdoutIsTTY?: boolean;
  /** Epoch milliseconds. */
  now?: () => number;
  signal?: AbortSignal;
};

// Node frees a Request that nothing holds, and its abort with it. A real fetch holds its own.
const waiting = new Set<Request>();

export const neverAnswers: Io["fetch"] = (request) => {
  waiting.add(request);
  return new Promise((_, reject) =>
    request.signal.addEventListener("abort", () => {
      waiting.delete(request);
      reject(request.signal.reason);
    }),
  );
};

export function cliFor(server: Pick<Server["runtime"], "app" | "token">, options: CliOptions = {}) {
  const homeDir = options.homeDir ?? tempDir();
  return async (...argv: string[]): Promise<Result> => {
    let stdout = "";
    let stderr = "";
    const io: Io = {
      env: options.env ?? { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_TOKEN: server.token },
      fetch: options.fetch ?? ((request) => Promise.resolve(server.app.request(request))),
      stdout: {
        write: (text) => {
          stdout += text;
        },
        isTTY: options.stdoutIsTTY ?? false,
      },
      stderr: {
        write: (text) => {
          stderr += text;
        },
      },
      stdin: {
        isTTY: options.stdin === null,
        read: async () => options.stdin ?? "",
      },
      promptSecret: async (label) => {
        if (!options.prompt) throw new Error(`unexpected prompt: ${label}`);
        return options.prompt(label);
      },
      homeDir,
      cwd: options.cwd ?? homeDir,
      now: options.now ?? Date.now,
      ...(options.signal && { signal: options.signal }),
    };
    const result = { code: await run(argv, io), stdout, stderr };
    if (result.code !== 0) problemOf(result);
    return result;
  };
}

export async function apiText(
  server: Pick<Server["runtime"], "app" | "token">,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string }> {
  const response = await server.app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${server.token}`,
      ...(init.body !== undefined && { "Content-Type": "application/json" }),
    },
  });
  return { status: response.status, text: await response.text() };
}

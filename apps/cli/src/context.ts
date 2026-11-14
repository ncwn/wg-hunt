import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Api, createApi, type Reply } from "./api/client.js";
import {
  type Connection,
  refusedTokenAdvice,
  requireToken,
  resolveConnection,
  type SignedConnection,
  sameOrigin,
} from "./config.js";
import type { Io } from "./io.js";
import { CliError, usageError } from "./problem.js";

export type GlobalOptions = { json?: boolean; url?: string };

export type Ctx = {
  io: Io;
  outcome: CliError | undefined;
  /** Never switched on by itself (not by a pipe, not by CI). */
  isJson(): boolean;
  connection(): SignedConnection;
  looseConnection(): Connection;
  api(): Api;
  anonymousApi(): Api;
  show<T>(reply: Reply<T>, human: (data: T) => string): void;
  /** Dropped under --json, so that stdout stays the API's JSON. */
  note(text: string): void;
  /** On stderr in both modes, before any problem, so that under --json the problem stays last. */
  warn(text: string): void;
  readJson(source: string): Promise<unknown>;
  readStdin(): Promise<string>;
};

export function createCtx(io: Io, globals: () => GlobalOptions): Ctx {
  let api: Api | undefined;
  let resolved: Connection | undefined;
  const warn = (text: string) => io.stderr.write(`wg-hunt: warning: ${text}\n`);
  const isJson = () => globals().json === true || io.env.WG_HUNT_OUTPUT === "json";

  function looseConnection(): Connection {
    resolved ??= resolveConnection(io, globals().url);
    return resolved;
  }

  let warned = false;
  function connection(): SignedConnection {
    const signed = requireToken(looseConnection());
    const { url, urlSource, tokenSource, savedUrl } = signed;
    if (!warned && urlSource === "flag" && tokenSource === "config" && savedUrl) {
      warned = true;
      if (!sameOrigin(url, savedUrl)) {
        warn(
          `the token \`wg-hunt login\` saved belongs to ${savedUrl}, not to ${url}; it is sent all the same.`,
        );
      }
    }
    return signed;
  }

  return {
    io,
    outcome: undefined,
    isJson,
    connection,
    looseConnection,
    api() {
      if (!api) {
        const { url, token, tokenSource } = connection();
        const signed = createApi({ url, token, fetch: io.fetch });
        api = {
          client: signed.client,
          send: (call) =>
            signed.send(call).catch((err: unknown) => {
              throw refused(err, tokenSource);
            }),
        };
      }
      return api;
    },
    anonymousApi() {
      return createApi({ url: looseConnection().url, fetch: io.fetch });
    },
    show(reply, human) {
      if (isJson()) {
        if (reply.text === "") return;
        io.stdout.write(io.stdout.isTTY ? `${reply.text}\n` : reply.text);
        return;
      }
      io.stdout.write(`${human(reply.data)}\n`);
    },
    note(text) {
      if (!isJson()) io.stdout.write(`${text}\n`);
    },
    warn,
    async readJson(source) {
      const text = source === "-" ? await readPiped(io) : await readInputFile(io, source);
      try {
        return JSON.parse(text);
      } catch {
        throw usageError(`${source === "-" ? "Standard input" : source} is not valid JSON.`);
      }
    },
    readStdin: () => readPiped(io),
  };
}

/** The server's own detail cannot know where the CLI found the token, so it says nothing to do. */
function refused(err: unknown, source: SignedConnection["tokenSource"]): unknown {
  if (!(err instanceof CliError) || err.problem.type !== "unauthorized") return err;
  return new CliError({ ...err.problem, detail: refusedTokenAdvice(source) }, err.exitCode);
}

async function readPiped(io: Io): Promise<string> {
  if (io.stdin.isTTY) throw usageError("Expected input on standard input, but it is a terminal.");
  return io.stdin.read();
}

async function readInputFile(io: Io, path: string): Promise<string> {
  try {
    return await readFile(resolve(io.cwd, path), "utf8");
  } catch {
    throw usageError(`Could not read ${path}.`);
  }
}

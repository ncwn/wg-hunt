import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Io } from "./io.js";
import { setupError } from "./problem.js";

const DEFAULT_URL = "http://127.0.0.1:8787";
/** Same name the server gives its token file inside the data folder. */
const TOKEN_FILE = "access-token";

/** `WG_HUNT_PORT` only changes the default, so it counts as `default`. */
export type UrlSource = "flag" | "env" | "config" | "default";
export type TokenSource = "env" | "config" | "data-folder" | "none";

export type Connection = {
  url: string;
  urlSource: UrlSource;
  token?: string;
  tokenSource: TokenSource;
  savedUrl?: string;
};

export type SignedConnection = Connection & {
  token: string;
  tokenSource: Exclude<TokenSource, "none">;
};

type StoredConfig = { url?: string; token?: string };

export function configPath(io: Pick<Io, "env" | "homeDir">): string {
  const base = io.env.XDG_CONFIG_HOME || join(io.homeDir, ".config");
  return join(base, "wg-hunt", "config.json");
}

function readConfig(io: Pick<Io, "env" | "homeDir">): StoredConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(io), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const { url, token } = parsed as Record<string, unknown>;
    return {
      ...(typeof url === "string" && url !== "" && { url }),
      ...(typeof token === "string" && token !== "" && { token }),
    };
  } catch {
    return {};
  }
}

export function writeConfig(io: Pick<Io, "env" | "homeDir">, config: Required<StoredConfig>): void {
  const file = configPath(io);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Written beside the file and renamed over it, so a crash never leaves half a config.
  const pending = `${file}.new`;
  writeFileSync(pending, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(pending, 0o600);
  renameSync(pending, file);
}

function readDataFolderToken(io: Pick<Io, "env" | "cwd">): string | undefined {
  const dataDir = io.env.WG_HUNT_DATA_DIR;
  if (!dataDir) return undefined;
  try {
    return readFileSync(join(resolve(io.cwd, dataDir), TOKEN_FILE), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function localUrl(env: Io["env"]): string {
  return env.WG_HUNT_PORT ? `http://127.0.0.1:${env.WG_HUNT_PORT}` : DEFAULT_URL;
}

function urlOf(
  io: Pick<Io, "env">,
  stored: StoredConfig,
  flagUrl: string | undefined,
): Pick<Connection, "url" | "urlSource"> {
  if (flagUrl) return { url: flagUrl, urlSource: "flag" };
  if (io.env.WG_HUNT_URL) return { url: io.env.WG_HUNT_URL, urlSource: "env" };
  if (stored.url) return { url: stored.url, urlSource: "config" };
  return { url: localUrl(io.env), urlSource: "default" };
}

function tokenOf(
  io: Pick<Io, "env" | "cwd">,
  stored: StoredConfig,
): Pick<Connection, "token" | "tokenSource"> {
  if (io.env.WG_HUNT_TOKEN) return { token: io.env.WG_HUNT_TOKEN, tokenSource: "env" };
  if (stored.token) return { token: stored.token, tokenSource: "config" };
  const folderToken = readDataFolderToken(io);
  if (folderToken) return { token: folderToken, tokenSource: "data-folder" };
  return { tokenSource: "none" };
}

/** The data-folder token comes last: it lets the CLI work in the container with no setup. */
export function resolveConnection(
  io: Pick<Io, "env" | "homeDir" | "cwd">,
  flagUrl?: string,
): Connection {
  const stored = readConfig(io);
  const { url, urlSource } = urlOf(io, stored, flagUrl);
  return {
    url: url.replace(/\/+$/, ""),
    urlSource,
    ...tokenOf(io, stored),
    ...(stored.url && { savedUrl: stored.url.replace(/\/+$/, "") }),
  };
}

export function requireToken(connection: Connection): SignedConnection {
  if (connection.tokenSource === "none" || !connection.token) {
    throw setupError(
      "not-configured",
      "No access token",
      "Run `wg-hunt login`, or set WG_HUNT_TOKEN (and WG_HUNT_URL) in the environment.",
    );
  }
  return connection as SignedConnection;
}

export function refusedTokenAdvice(source: SignedConnection["tokenSource"]): string {
  switch (source) {
    case "env":
      return "The token comes from WG_HUNT_TOKEN and the server does not take it. Set the variable to the current token; `wg-hunt login` does not help while the variable is set.";
    case "config":
      return "The token `wg-hunt login` saved is not taken any more. Run `wg-hunt login` with the current token.";
    case "data-folder":
      return "The token is read from the data folder on every run, so run the command again. If it is refused again, WG_HUNT_DATA_DIR is not this server's data folder.";
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.trim() === b.trim();
  }
}

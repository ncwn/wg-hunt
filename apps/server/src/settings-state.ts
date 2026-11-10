import { z } from "@hono/zod-openapi";
import type { Db } from "./db/index.js";
import { getSetting } from "./db/settings.js";

const SETTINGS_SOURCES = ["saved", "default", "partly-unreadable"] as const;
type SettingsSource = (typeof SETTINGS_SOURCES)[number];

export type SettingsState = { source: SettingsSource; unreadable: string[] };

export const settingsStateSchema = z
  .object({
    source: z.enum(SETTINGS_SOURCES).openapi({
      description:
        "`saved`: the settings are as saved. `default`: nothing is saved, so the defaults are in use. `partly-unreadable`: what is saved no longer parses as a whole, after an upgrade for instance; the fields in `unreadable` are back at their default, every other field kept its saved value, and the stored settings stay as they are until they are saved again.",
    }),
    unreadable: z.array(z.string()).openapi({
      description:
        "The fields that went back to their default, as dotted names such as `pacing.dailyCap`; empty unless `source` is `partly-unreadable`.",
      example: ["effort"],
    }),
  })
  .openapi("SettingsState", {
    description:
      "Where the settings document the status is for came from (`GET /settings/analysis` for `GET /analysis`, `GET /settings/crawl` for `GET /crawl`), and which of its fields went back to their default because what is saved no longer parses.",
  });

export type ReadSettings<T> = SettingsState & { settings: T };

export type SalvageSpec<T> = {
  schema: z.ZodType<T>;
  /** By dotted name, in the order to name them. */
  fields: Record<string, z.ZodType>;
  /** Fields a rule ties together. */
  tied: string[][];
  defaults: () => T;
};

function salvage<T>(spec: SalvageSpec<T>, stored: string | undefined): ReadSettings<T> {
  if (stored === undefined) return { settings: spec.defaults(), source: "default", unreadable: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    raw = undefined;
  }
  const whole = spec.schema.safeParse(raw);
  if (whole.success) return { settings: whole.data, source: "saved", unreadable: [] };

  const names = Object.keys(spec.fields);
  const fallback = spec.defaults();
  const candidate = spec.defaults();
  const fallen = new Set<string>();
  const withGroup = (name: string) => {
    for (const each of spec.tied.find((group) => group.includes(name)) ?? [name]) {
      fallen.add(each);
      setAt(candidate, each, valueAt(fallback, each));
    }
  };

  for (const name of names) {
    const parsed = spec.fields[name]?.safeParse(valueAt(raw, name));
    if (parsed?.success) setAt(candidate, name, parsed.data);
    else fallen.add(name);
  }

  for (;;) {
    const parsed = spec.schema.safeParse(candidate);
    const unreadable = names.filter((name) => fallen.has(name));
    if (parsed.success) return { settings: parsed.data, source: "partly-unreadable", unreadable };
    const before = fallen.size;
    for (const issue of parsed.error.issues) {
      const name = fieldAt(issue.path, names);
      if (name !== undefined) withGroup(name);
    }
    if (fallen.size === before) {
      return { settings: spec.defaults(), source: "partly-unreadable", unreadable: names };
    }
  }
}

/** The engine reads its settings every step. */
const logged = new WeakMap<Db, Map<string, string>>();

/** Logs by name only: a value may be the seeker's own. */
export function readSettings<T>(db: Db, key: string, spec: SalvageSpec<T>): ReadSettings<T> {
  const read = salvage(spec, getSetting(db, key)?.value);
  let byKey = logged.get(db);
  if (byKey === undefined) {
    byKey = new Map();
    logged.set(db, byKey);
  }
  const names = read.unreadable.join(",");
  if (byKey.get(key) !== names) {
    byKey.set(key, names);
    for (const name of read.unreadable) {
      console.error(
        `Saved setting ${key} › ${name} could not be read; its default is in use until the settings are saved.`,
      );
    }
  }
  return read;
}

function valueAt(value: unknown, dotted: string): unknown {
  let at = value;
  for (const part of dotted.split(".")) {
    if (typeof at !== "object" || at === null || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

function setAt(target: unknown, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  const last = parts.pop() as string;
  let at = target as Record<string, unknown>;
  for (const part of parts) at = at[part] as Record<string, unknown>;
  at[last] = value;
}

function fieldAt(path: readonly PropertyKey[], names: string[]): string | undefined {
  let found: string | undefined;
  for (const name of names) {
    const parts = name.split(".");
    if (parts.length > path.length) continue;
    if (!parts.every((part, i) => String(path[i]) === part)) continue;
    if (found === undefined || parts.length > found.split(".").length) found = name;
  }
  return found;
}

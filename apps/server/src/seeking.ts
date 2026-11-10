import {
  defaultFilters,
  defaultSeekerProfile,
  type Filters,
  parseFilters,
  type SeekerProfile,
  type Seeking,
  seekerProfileSchema,
} from "@wg-hunt/core";
import type { Db } from "./db/index.js";
import { getSetting, putSetting } from "./db/settings.js";

/** One Seeker Profile and one active Filter set per install, in the settings table. */
const PROFILE_KEY = "seeker-profile";
const FILTERS_KEY = "filters";

function load<T>(db: Db, key: string, read: (saved: unknown) => T | null, fallback: () => T): T {
  const row = getSetting(db, key);
  if (row) {
    try {
      const parsed = read(JSON.parse(row.value));
      if (parsed !== null) return parsed;
    } catch {
      // Falls through to the defaults.
    }
  }
  return fallback();
}

export function loadProfile(db: Db): SeekerProfile {
  return load(
    db,
    PROFILE_KEY,
    (saved) => {
      const parsed = seekerProfileSchema.safeParse({
        ...defaultSeekerProfile(),
        ...(saved as object),
      });
      return parsed.success ? parsed.data : null;
    },
    defaultSeekerProfile,
  );
}

export function saveProfile(db: Db, profile: SeekerProfile): void {
  putSetting(db, PROFILE_KEY, JSON.stringify(profile));
}

export function loadFilters(db: Db): Filters {
  return load(db, FILTERS_KEY, parseFilters, defaultFilters);
}

export function saveFilters(db: Db, filters: Filters): void {
  putSetting(db, FILTERS_KEY, JSON.stringify(filters));
}

export function loadSeeking(db: Db): Seeking {
  return { profile: loadProfile(db), filters: loadFilters(db) };
}

export function saveSeeking(db: Db, changes: Partial<Seeking>): void {
  db.$client.transaction(() => {
    if (changes.profile) saveProfile(db, changes.profile);
    if (changes.filters) saveFilters(db, changes.filters);
  })();
}

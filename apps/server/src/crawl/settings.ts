import { z } from "@hono/zod-openapi";
import type { Db } from "../db/index.js";
import { type ReadSettings, readSettings, type SalvageSpec } from "../settings-state.js";
import { DAILY_CEILING, GAP_FLOOR_SECONDS } from "./constants.js";
import { writeJson } from "./kv.js";

const KEY = "crawl.settings";

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour, Europe/Berlin")
  .openapi({ example: "07:00" });

const gapSeconds = z
  .number()
  .int()
  .min(GAP_FLOOR_SECONDS, `a gap cannot be under the ${GAP_FLOOR_SECONDS} s floor`);
const dailyCap = z
  .number()
  .int()
  .min(1)
  .max(DAILY_CEILING, `at most ${DAILY_CEILING} requests per day (the ceiling)`);
const hourlyCap = z
  .number()
  .int()
  .min(1)
  .max(DAILY_CEILING, `at most ${DAILY_CEILING} requests per hour (the daily ceiling)`);

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

const pacingSchema = z
  .object({
    gapMinSeconds: gapSeconds,
    gapMaxSeconds: gapSeconds,
    sessionSize: z.number().int().min(1),
    breakMinMinutes: z.number().int().min(1),
    breakMaxMinutes: z.number().int().min(1),
    hourlyCap,
    dailyCap,
    activeHours: z.object({ start: clock, end: clock }),
  })
  .refine((p) => p.gapMinSeconds <= p.gapMaxSeconds, {
    message: "gapMinSeconds must not exceed gapMaxSeconds",
    path: ["gapMinSeconds"],
  })
  .refine((p) => p.breakMinMinutes <= p.breakMaxMinutes, {
    message: "breakMinMinutes must not exceed breakMaxMinutes",
    path: ["breakMinMinutes"],
  })
  .refine((p) => toMinutes(p.activeHours.start) < toMinutes(p.activeHours.end), {
    message: "active hours must start before they end, within one day",
    path: ["activeHours"],
  });

const recheckSchema = z.object({
  enabled: z.boolean(),
  maxPageAgeHours: z.number().int().min(1).max(720),
});

export const crawlSettingsSchema = z
  .object({ pacing: pacingSchema, recheck: recheckSchema })
  .openapi("CrawlSettings");

export type CrawlSettings = z.infer<typeof crawlSettingsSchema>;

export function defaultCrawlSettings(): CrawlSettings {
  return {
    pacing: {
      gapMinSeconds: 20,
      gapMaxSeconds: 60,
      sessionSize: 15,
      breakMinMinutes: 10,
      breakMaxMinutes: 30,
      hourlyCap: 30,
      dailyCap: 300,
      activeHours: { start: "07:00", end: "23:30" },
    },
    recheck: { enabled: true, maxPageAgeHours: 72 },
  };
}

const salvageSpec: SalvageSpec<CrawlSettings> = {
  schema: crawlSettingsSchema,
  // One level down, so that a field added to `pacing` does not take the daily cap with it.
  fields: Object.fromEntries([
    ...Object.entries(pacingSchema.shape).map(([name, field]) => [`pacing.${name}`, field]),
    ...Object.entries(recheckSchema.shape).map(([name, field]) => [`recheck.${name}`, field]),
  ]),
  tied: [
    ["pacing.gapMinSeconds", "pacing.gapMaxSeconds"],
    ["pacing.breakMinMinutes", "pacing.breakMaxMinutes"],
  ],
  defaults: defaultCrawlSettings,
};

export function readCrawlSettings(db: Db): ReadSettings<CrawlSettings> {
  return readSettings(db, KEY, salvageSpec);
}

export function loadCrawlSettings(db: Db): CrawlSettings {
  return readCrawlSettings(db).settings;
}

export function saveCrawlSettings(db: Db, value: CrawlSettings, now: number): CrawlSettings {
  const valid = crawlSettingsSchema.parse(value);
  writeJson(db, KEY, valid, now);
  return valid;
}

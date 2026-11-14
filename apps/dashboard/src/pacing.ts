import type { components } from "./api/schema.js";

export type CrawlSettings = components["schemas"]["CrawlSettings"];
export type CrawlConstants = components["schemas"]["CrawlConstants"];

export type PacingForm = {
  gapMinSeconds: string;
  gapMaxSeconds: string;
  sessionSize: string;
  breakMinMinutes: string;
  breakMaxMinutes: string;
  hourlyCap: string;
  dailyCap: string;
  activeStart: string;
  activeEnd: string;
  recheckEnabled: boolean;
  maxPageAgeHours: string;
};

export type FieldKey = keyof PacingForm;
export type FieldErrors = Partial<Record<FieldKey, string>>;

export function toForm(settings: CrawlSettings): PacingForm {
  const { pacing, recheck } = settings;
  return {
    gapMinSeconds: String(pacing.gapMinSeconds),
    gapMaxSeconds: String(pacing.gapMaxSeconds),
    sessionSize: String(pacing.sessionSize),
    breakMinMinutes: String(pacing.breakMinMinutes),
    breakMaxMinutes: String(pacing.breakMaxMinutes),
    hourlyCap: String(pacing.hourlyCap),
    dailyCap: String(pacing.dailyCap),
    activeStart: pacing.activeHours.start,
    activeEnd: pacing.activeHours.end,
    recheckEnabled: recheck.enabled,
    maxPageAgeHours: String(recheck.maxPageAgeHours),
  };
}

export const isDraft = (stored: PacingForm, form: PacingForm) =>
  (Object.keys(stored) as FieldKey[]).some((key) => stored[key] !== form[key]);

const WHOLE = /^\d+$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 30 days, as the server allows. */
const MAX_PAGE_AGE_HOURS = 720;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function check(
  form: PacingForm,
  constants: CrawlConstants,
): { settings: CrawlSettings } | { errors: FieldErrors } {
  const errors: FieldErrors = {};
  const whole = (key: FieldKey, min: number, max: number, tooLow?: string, tooHigh?: string) => {
    const text = (form[key] as string).trim();
    if (!WHOLE.test(text)) {
      errors[key] = "Enter a whole number.";
      return 0;
    }
    const value = Number(text);
    if (value < min) errors[key] = tooLow ?? `At least ${min}.`;
    else if (value > max) errors[key] = tooHigh ?? `At most ${max}.`;
    return value;
  };

  const floor = constants.gapFloorSeconds;
  const underFloor = `A gap can't be under the ${floor} s floor.`;
  const gapMinSeconds = whole("gapMinSeconds", floor, Number.MAX_SAFE_INTEGER, underFloor);
  const gapMaxSeconds = whole("gapMaxSeconds", floor, Number.MAX_SAFE_INTEGER, underFloor);
  if (!errors.gapMinSeconds && !errors.gapMaxSeconds && gapMinSeconds > gapMaxSeconds) {
    errors.gapMinSeconds = "The shortest gap can't be longer than the longest gap.";
  }

  const sessionSize = whole("sessionSize", 1, Number.MAX_SAFE_INTEGER);
  const breakMinMinutes = whole("breakMinMinutes", 1, Number.MAX_SAFE_INTEGER);
  const breakMaxMinutes = whole("breakMaxMinutes", 1, Number.MAX_SAFE_INTEGER);
  if (!errors.breakMinMinutes && !errors.breakMaxMinutes && breakMinMinutes > breakMaxMinutes) {
    errors.breakMinMinutes = "The shortest break can't be longer than the longest break.";
  }

  const ceiling = constants.dailyCeiling;
  const hourlyCap = whole(
    "hourlyCap",
    1,
    ceiling,
    undefined,
    `At most ${ceiling} requests an hour (the daily ceiling).`,
  );
  const dailyCap = whole(
    "dailyCap",
    1,
    ceiling,
    undefined,
    `At most ${ceiling} requests a day (the ceiling).`,
  );

  if (!CLOCK.test(form.activeStart)) errors.activeStart = "Use a time such as 07:00.";
  if (!CLOCK.test(form.activeEnd)) errors.activeEnd = "Use a time such as 23:30.";
  if (
    !errors.activeStart &&
    !errors.activeEnd &&
    minutesOf(form.activeStart) >= minutesOf(form.activeEnd)
  ) {
    errors.activeEnd = "Active hours must start before they end, within one day.";
  }

  const maxPageAgeHours = whole("maxPageAgeHours", 1, MAX_PAGE_AGE_HOURS);

  if (Object.keys(errors).length > 0) return { errors };
  return {
    settings: {
      pacing: {
        gapMinSeconds,
        gapMaxSeconds,
        sessionSize,
        breakMinMinutes,
        breakMaxMinutes,
        hourlyCap,
        dailyCap,
        activeHours: { start: form.activeStart, end: form.activeEnd },
      },
      recheck: { enabled: form.recheckEnabled, maxPageAgeHours },
    },
  };
}

const SERVER_PATHS: Record<string, FieldKey> = {
  "pacing.gapMinSeconds": "gapMinSeconds",
  "pacing.gapMaxSeconds": "gapMaxSeconds",
  "pacing.sessionSize": "sessionSize",
  "pacing.breakMinMinutes": "breakMinMinutes",
  "pacing.breakMaxMinutes": "breakMaxMinutes",
  "pacing.hourlyCap": "hourlyCap",
  "pacing.dailyCap": "dailyCap",
  "pacing.activeHours": "activeEnd",
  "pacing.activeHours.start": "activeStart",
  "pacing.activeHours.end": "activeEnd",
  "recheck.enabled": "recheckEnabled",
  "recheck.maxPageAgeHours": "maxPageAgeHours",
};

export function sortServerErrors(errors: { path: string; message: string }[]) {
  const byField: FieldErrors = {};
  const general: string[] = [];
  for (const { path, message } of errors) {
    const key = SERVER_PATHS[path];
    if (key) byField[key] = byField[key] ? `${byField[key]} ${message}` : message;
    else general.push(path ? `${path}: ${message}` : message);
  }
  return { byField, general };
}

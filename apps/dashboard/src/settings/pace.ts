import type { CrawlSettings } from "../pacing.js";

export type Pace = "gentle" | "normal" | "eager";

export const PACES: Record<
  Pace,
  {
    label: string;
    gapMinSeconds: number;
    gapMaxSeconds: number;
    hourlyCap: number;
    dailyCap: number;
  }
> = {
  gentle: { label: "Gently", gapMinSeconds: 30, gapMaxSeconds: 90, hourlyCap: 15, dailyCap: 150 },
  normal: { label: "Normal", gapMinSeconds: 20, gapMaxSeconds: 60, hourlyCap: 30, dailyCap: 300 },
  eager: { label: "Eager", gapMinSeconds: 15, gapMaxSeconds: 40, hourlyCap: 45, dailyCap: 450 },
};

export function paceOf(settings: CrawlSettings): Pace | "custom" {
  const { pacing } = settings;
  for (const [name, pace] of Object.entries(PACES) as [Pace, (typeof PACES)[Pace]][]) {
    if (
      pacing.gapMinSeconds === pace.gapMinSeconds &&
      pacing.gapMaxSeconds === pace.gapMaxSeconds &&
      pacing.hourlyCap === pace.hourlyCap &&
      pacing.dailyCap === pace.dailyCap
    ) {
      return name;
    }
  }
  return "custom";
}

export function withPace(settings: CrawlSettings, pace: Pace): CrawlSettings {
  const { label: _label, ...values } = PACES[pace];
  return { ...settings, pacing: { ...settings.pacing, ...values } };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export function withQuietHours(
  settings: CrawlSettings,
  quietFrom: string,
  quietUntil: string,
): { settings: CrawlSettings } | { problem: string } {
  if (!CLOCK.test(quietFrom) || !CLOCK.test(quietUntil)) {
    return { problem: "Use times such as 23:00 and 07:00." };
  }
  if (minutes(quietUntil) >= minutes(quietFrom)) {
    return {
      problem: "Quiet hours run overnight: they start in the evening and end the next morning.",
    };
  }
  return {
    settings: {
      ...settings,
      pacing: { ...settings.pacing, activeHours: { start: quietUntil, end: quietFrom } },
    },
  };
}

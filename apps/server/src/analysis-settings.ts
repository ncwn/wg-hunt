import { z } from "@hono/zod-openapi";
import { DEFAULT_PRICES, EFFORTS, type Effort } from "@wg-hunt/core";
import type { Db } from "./db/index.js";
import { putSetting } from "./db/settings.js";
import { type ReadSettings, readSettings, type SalvageSpec } from "./settings-state.js";

const modelId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,99}$/, "Not a model id such as claude-haiku-5-5.");
const effort = z.enum(EFFORTS);
const usd = z.number().min(0).max(1_000_000);

const modelPrice = z
  .object({
    model: modelId,
    inputUsdPerMTok: usd,
    outputUsdPerMTok: usd,
    /** Empty for a model with no effort parameter. */
    efforts: z.array(effort).max(EFFORTS.length),
    /**
     * A model that costs more for long prompts: above this many input tokens (cache reads and
     * writes counted) the whole request, output too, is billed at these rates.
     */
    longPrompt: z
      .object({
        aboveTokens: z.number().int().min(1),
        inputUsdPerMTok: usd,
        outputUsdPerMTok: usd,
      })
      .nullable()
      .optional(),
  })
  .openapi("ModelPrice");

const modelChoice = z.object({ model: modelId, effort: effort.nullable() });

export const analysisSettingsSchema = z
  .object({
    model: modelId,
    /** `null` only for a model whose price-table entry lists no efforts. */
    effort: effort.nullable(),
    /** `null` for off. */
    escalation: modelChoice.nullable(),
    batchOnly: z.boolean(),
    monthlySpendCapUsd: z.number().min(0).max(100_000),
    /** Standard-API prices; batch is half. */
    prices: z.array(modelPrice).max(200),
  })
  .superRefine((settings, ctx) => {
    const seen = new Set<string>();
    settings.prices.forEach((price, i) => {
      if (seen.has(price.model)) {
        ctx.addIssue({
          code: "custom",
          path: ["prices", i, "model"],
          message: `${price.model} is in the price table more than once.`,
        });
      }
      seen.add(price.model);
    });

    const check = (
      label: string,
      pass: { model: string; effort: Effort | null },
      path: string[],
    ) => {
      const entry = settings.prices.find((price) => price.model === pass.model);
      const issue = (field: "model" | "effort", message: string) =>
        ctx.addIssue({ code: "custom", path: [...path, field], message: `${label}: ${message}` });
      if (!entry) {
        issue("model", `${pass.model} is not in the price table. Add it there first.`);
      } else if (entry.efforts.length === 0) {
        if (pass.effort !== null) {
          issue("effort", `${pass.model} takes no effort; set it to null.`);
        }
      } else if (pass.effort === null) {
        issue("effort", `${pass.model} needs an effort (${entry.efforts.join(", ")}).`);
      } else if (!entry.efforts.includes(pass.effort)) {
        issue(
          "effort",
          `${pass.model} does not support effort ${pass.effort} (it supports ${entry.efforts.join(", ")}).`,
        );
      }
    };
    check("Model pass", settings, []);
    if (settings.escalation) check("Escalation", settings.escalation, ["escalation"]);
  })
  .openapi("AnalysisSettings");

export type AnalysisSettings = z.infer<typeof analysisSettingsSchema>;

export function defaultAnalysisSettings(): AnalysisSettings {
  return {
    model: "claude-haiku-5-5",
    effort: "medium",
    escalation: { model: "claude-haiku-5-5", effort: "high" },
    batchOnly: false,
    monthlySpendCapUsd: 5,
    prices: DEFAULT_PRICES.map((price) => ({
      ...price,
      efforts: [...price.efforts],
      ...(price.longPrompt && { longPrompt: { ...price.longPrompt } }),
    })),
  };
}

const KEY = "analysis";

const salvageSpec: SalvageSpec<AnalysisSettings> = {
  schema: analysisSettingsSchema,
  fields: analysisSettingsSchema.shape,
  // The price table and the rules for the two passes refer to each other.
  tied: [["model", "effort", "escalation", "prices"]],
  defaults: defaultAnalysisSettings,
};

export function readAnalysisSettings(db: Db): ReadSettings<AnalysisSettings> {
  return readSettings(db, KEY, salvageSpec);
}

export function loadAnalysisSettings(db: Db): AnalysisSettings {
  return readAnalysisSettings(db).settings;
}

export function saveAnalysisSettings(db: Db, settings: AnalysisSettings): void {
  putSetting(db, KEY, JSON.stringify(settings));
}

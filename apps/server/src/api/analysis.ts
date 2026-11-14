import { createRoute, z } from "@hono/zod-openapi";
import {
  RUN_STATUSES,
  RUN_STOP_REASONS,
  START_RUN_REFUSALS,
  type StartRunRefusal,
} from "../analysis/run-status.js";
import { settingsStateSchema } from "../settings-state.js";
import { analysisStatusCounts } from "./analysis-status.js";
import type { ApiModule } from "./context.js";
import { ProblemError, problemResponses } from "./problem.js";

const statusSchema = z
  .object({
    key: z.enum(["absent", "present", "refused"]).openapi({
      description:
        "`absent` (no key: Offers stay `pending` and crawling goes on), `present`, or `refused`: the API answered `unauthorized` to the key that is set. It stays refused until a key is saved, the same one included, or a call with it goes through.",
    }),
    counts: z.object({
      pending: z.number().int(),
      analyzed: z.number().int(),
      failed: z.number().int(),
    }),
    awaiting: z.number().int().openapi({
      description:
        "Offers that will be read without anyone doing anything (`willRead`): reading, queued, in a batch, provisional, with changed words, or waiting for what is in flight to settle. Offers waiting for a key, the month's cap, a backoff, a page or a click are not counted; `byStatus` has them.",
    }),
    byStatus: analysisStatusCounts,
    version: z.string().openapi({
      description:
        "The analysis version the current settings produce: a hash of the prompt, the output schema, the model id and the effort. Every stored result is stamped with the version it was made at.",
    }),
    olderVersion: z
      .object({
        count: z.number().int().openapi({
          description:
            "Non-Stale Offers whose stored result was made at another analysis version, not already in a batch. Nothing re-runs until `POST /analysis/runs`.",
        }),
        estimatedCostUsd: z.number().openapi({
          description:
            "About what re-analysing them as a batch would cost, from the price table at the Batch API's half price.",
        }),
      })
      .openapi("OlderAnalysisVersion"),
    spend: z
      .object({
        month: z.string().openapi({
          example: "2026-11",
          description: "The Berlin calendar month being counted. The cap starts over each month.",
        }),
        spentUsd: z.number().openapi({
          description: "This month's spend, from the tokens each call used and the price table.",
        }),
        capUsd: z.number(),
        reservedUsd: z.number().openapi({
          description:
            "Worst-case cost held against the cap by realtime calls in flight and batches whose results are not in. Each is replaced by its actual cost when it settles.",
        }),
        headroomUsd: z.number().openapi({
          description:
            "What may still be reserved: the cap less this month's spend and every reservation. Negative when the cap was lowered under what is reserved.",
        }),
        state: z.enum(["ok", "waiting-for-in-flight", "reached"]).openapi({
          description:
            "Whether model calls may go out. `ok`: the cap less this month's spend and what batches in flight reserved pays for at least one typical batch call (realtime calls in flight are not counted here). `waiting-for-in-flight`: it does not, but would once the batches in flight settle, so this may clear by itself. `reached`: even with nothing in flight, this month's cap pays for no call; it clears at `resetsAt` or with a higher cap. In either held state no new call goes out, new Offers stay `pending`, re-analysis runs and Re-analyse are refused with `spend-cap-reached`, and crawling goes on. A re-analysis run can be refused with `spend-cap-reached` while this is `ok`, because a run needs room for an escalation too: `actions.startRunRefusedBy` says whether it would be.",
        }),
        resetsAt: z.string().openapi({
          example: "2026-11-30T23:00:00.000Z",
          description: "When the next Berlin calendar month, and with it a fresh cap, starts.",
        }),
      })
      .openapi("AnalysisSpend"),
    activeRunId: z.number().int().nullable().openapi({
      description: "The re-analysis run still going, or null. Only one runs at a time.",
    }),
    actions: z
      .object({
        startRun: z.boolean().openapi({
          description:
            "`POST /analysis/runs` would start a run now. False exactly when `startRunRefusedBy` says why it would be refused.",
        }),
        startRunRefusedBy: z.enum(START_RUN_REFUSALS).nullable().openapi({
          description:
            "The problem type `POST /analysis/runs` would answer with now, checked in this order. `no-api-key`: no key is set. `api-key-refused`: the API refuses the key that is set. `spend-cap-reached`: what is left of this month's cap, less what batches in flight reserved, does not pay for reading one typical Offer again in full at batch price, its first pass and, when escalation is on, its escalation, counted at their worst case; this can be so while `spend.state` is `ok`. `analysis-run-active`: a run is still going (`activeRunId`). `nothing-to-reanalyze`: no Offer is on an older analysis (`olderVersion.count` is 0). Null when it would start.",
        }),
      })
      .openapi("AnalysisActions"),
    settings: settingsStateSchema,
  })
  .openapi("AnalysisStatus");

const runSchema = z
  .object({
    id: z.number().int(),
    status: z.enum(RUN_STATUSES).openapi({
      description:
        "`running` until every request is settled; then `succeeded`, `partial` (some failed), `failed` (none kept) or `stopped` (see `stopReason`). Written once when the run settles: deleting its Offers later does not change it.",
    }),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    analysisVersion: z.string().openapi({ description: "The version the run brings Offers to." }),
    estimatedCostUsd: z.number(),
    actualCostUsd: z.number().openapi({
      description:
        "What the run's calls have cost so far, from recorded usage and the price table.",
    }),
    counts: z.object({
      total: z.number().int(),
      applied: z.number().int().openapi({ description: "A new result was kept." }),
      failed: z.number().int().openapi({
        description: "The request failed. The Offer keeps its previous result.",
      }),
      capped: z
        .number()
        .int()
        .openapi({ description: "The spend cap stopped it before it was sent." }),
      dropped: z.number().int().openapi({
        description: "Thrown away: the Offer's words changed while the batch ran, or it is gone.",
      }),
      pending: z.number().int().openapi({ description: "Still waiting for, or inside, a batch." }),
    }),
    errorKinds: z.record(z.string(), z.number().int()).openapi({
      description:
        "Failed or capped Offers by error kind, such as `overloaded` or `spend_cap_reached`; `{}` when none.",
    }),
    stopReason: z.enum(RUN_STOP_REASONS).nullable().openapi({
      description:
        'Why a `stopped` run stopped: `spend-cap-reached` (the cap ran out, or was lowered and canceled what was out) or `interrupted` ("Delete all Offer data" removed the Offers it was still reading). Null otherwise.',
    }),
  })
  .openapi("AnalysisRun");

const statusRoute = createRoute({
  method: "get",
  path: "/analysis",
  tags: ["Analysis"],
  summary:
    "Analysis state: pending, analysed and failed Offers, how many are in each analysis status, whether a key is set or refused, Offers on an older analysis version with a cost estimate, and spend against the cap",
  responses: {
    200: {
      description: "The analysis status",
      content: { "application/json": { schema: statusSchema } },
    },
    ...problemResponses("unauthorized"),
  },
});

const startRoute = createRoute({
  method: "post",
  path: "/analysis/runs",
  tags: ["Analysis"],
  summary: "Re-analyse the Offers on an older analysis, as a batch",
  description:
    "The only way a re-analysis run starts. It reads every non-Stale Offer whose result is on an older analysis version again through the Message Batches API, and answers `202` with the run. The previous result of each Offer stays current until its new one succeeds; a failed request leaves it. Refused with `no-api-key` when no key is set; with `api-key-refused` while the API refuses the key that is set (`key: refused` on `GET /analysis`); with `spend-cap-reached` when what is left of this month's cap, less what batches in flight reserved, does not pay for one typical Offer's first pass and, when escalation is on, its escalation, at batch price and worst case, which can be so while `spend.state` is `ok`; with `analysis-run-active` while a run is still going; and with `nothing-to-reanalyze` when no Offer is on an older analysis (`olderVersion.count` on `GET /analysis` is 0). `actions.startRunRefusedBy` on `GET /analysis` says which of these it would answer now. The run stops sending (status `stopped`) if the cap runs out before every request is out. Progress arrives as `analysis-run-progress` events, or poll `GET /analysis/runs/{id}`.",
  responses: {
    202: {
      description: "The run was started",
      content: { "application/json": { schema: runSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "no-api-key",
      "api-key-refused",
      "spend-cap-reached",
      "analysis-run-active",
      "nothing-to-reanalyze",
      "origin-not-allowed",
    ),
  },
});

const runRoute = createRoute({
  method: "get",
  path: "/analysis/runs/{id}",
  tags: ["Analysis"],
  summary: "A re-analysis run and how far it has got",
  request: { params: z.object({ id: z.coerce.number().int().min(1) }) },
  responses: {
    200: { description: "The run", content: { "application/json": { schema: runSchema } } },
    ...problemResponses("unauthorized", "validation-error", "not-found"),
  },
});

/** A record, so a refusal added to `START_RUN_REFUSALS` fails to compile until it has an answer. */
const RUN_REFUSALS: Record<StartRunRefusal, string> = {
  "no-api-key": "Set an Anthropic API key in Settings first. The model pass needs one.",
  "api-key-refused":
    "The Anthropic API refused the key that is set, so the model pass would fail. Replace the key in Settings.",
  "spend-cap-reached":
    "What is left of this month's spend cap does not pay for reading one Offer again in full as a batch: its first pass and, when escalation is on, its escalation (see `spend` on GET /analysis). Raise the cap in Settings, or wait for the analysis in flight to settle or for the next month.",
  "analysis-run-active": "A re-analysis run is still going. Start another when it has finished.",
  "nothing-to-reanalyze":
    "No Offer is on an older analysis, so there is nothing to read again. A run is only needed after the model or effort changes.",
};

export const registerAnalysis: ApiModule = (api, { analysis }) => {
  api.openapi(statusRoute, (c) => c.json(analysis.status(), 200));

  api.openapi(startRoute, (c) => {
    const started = analysis.batch.startRun();
    if (!started.ok) throw new ProblemError(started.reason, RUN_REFUSALS[started.reason]);
    return c.json(started.run, 202);
  });

  api.openapi(runRoute, (c) => {
    const { id } = c.req.valid("param");
    const run = analysis.batch.run(id);
    if (run === undefined) throw new ProblemError("not-found", `There is no analysis run ${id}.`);
    return c.json(run, 200);
  });
};

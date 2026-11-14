import type { Command } from "commander";
import type { components } from "../api/schema.js";
import type { Ctx } from "../context.js";
import { describe, pairs, settingsStateText, when } from "../format.js";
import { usageError } from "../problem.js";
import {
  ifMatchFor,
  ifMatchHeader,
  type RevisionOptions,
  revisionOptions,
  showRevisioned,
} from "./revision.js";

type Run = components["schemas"]["AnalysisRun"];
type Status = components["schemas"]["AnalysisStatus"];
type CrawlSettings = components["schemas"]["CrawlSettings"];
type AnalysisSettings = components["schemas"]["AnalysisSettings"];
type Storage = components["schemas"]["Storage"];

const usd = (amount: number) => `$${amount.toFixed(2)}`;

function capNote(spend: Status["spend"]): string {
  if (spend.state === "ok") return "";
  return ` (cap ${spend.state}, ${usd(spend.reservedUsd)} reserved; resets ${when(spend.resetsAt)})`;
}

function byStatusText(counts: Status["byStatus"]): string | undefined {
  const held = Object.entries(counts).filter(([, n]) => n > 0);
  return held.length === 0 ? undefined : held.map(([s, n]) => `${s} ${n}`).join(", ");
}

type RunRefusal = NonNullable<Status["actions"]["startRunRefusedBy"]>;

// Typed as a record so that a refusal added to the API fails to compile here.
const RUN_REFUSALS: Record<RunRefusal, string> = {
  "no-api-key": "no-api-key: no Anthropic key is set",
  "api-key-refused": "api-key-refused: the Anthropic API refuses the key that is set",
  "spend-cap-reached":
    "spend-cap-reached: what is left of the cap does not pay for reading one Offer again in full",
  "analysis-run-active": "analysis-run-active: a run is still going",
  "nothing-to-reanalyze": "nothing-to-reanalyze: no Offer is on an older analysis",
};

function statusText(status: Status): string {
  // An older server sends no `actions`.
  const refusal = status.olderVersion.count > 0 ? status.actions?.startRunRefusedBy : undefined;
  return pairs([
    ["Anthropic key", status.key],
    ["Analysed", status.counts.analyzed],
    ["Pending", status.counts.pending],
    ["Failed", status.counts.failed],
    ["Awaiting analysis", status.awaiting],
    ["By status", byStatusText(status.byStatus)],
    ["Analysis version", status.version],
    [
      "On an older analysis",
      `${status.olderVersion.count} Offers, about ${usd(status.olderVersion.estimatedCostUsd)} to re-analyse`,
    ],
    ["A run would be refused", refusal ? (RUN_REFUSALS[refusal] ?? refusal) : undefined],
    [
      `Spend ${status.spend.month}`,
      `${usd(status.spend.spentUsd)} of ${usd(status.spend.capUsd)}${capNote(status.spend)}`,
    ],
    ["Re-analysis run going", status.activeRunId ?? undefined],
    ["Settings", settingsStateText(status.settings, "analysis")],
  ]);
}

function runText(run: Run): string {
  return pairs([
    ["Run", run.id],
    ["Status", run.status],
    ["Started", when(run.createdAt)],
    ["Finished", run.finishedAt ? when(run.finishedAt) : undefined],
    ["Offers", run.counts.total],
    ["Applied", run.counts.applied],
    ["Failed", run.counts.failed],
    ["Held back by the cap", run.counts.capped],
    ["Dropped", run.counts.dropped],
    ["Still pending", run.counts.pending],
    ["Estimated cost", usd(run.estimatedCostUsd)],
    ["Cost so far", usd(run.actualCostUsd)],
    ["Stopped because", run.stopReason],
    [
      "Error kinds",
      Object.entries(run.errorKinds)
        .map(([kind, n]) => `${kind} ${n}`)
        .join(", ") || undefined,
    ],
  ]);
}

function runId(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw usageError(`"${text}" is not a run id.`);
  return Number(text);
}

export function registerAnalysis(program: Command, ctx: Ctx): void {
  const analysis = program
    .command("analysis")
    .description("The model pass: what is pending, what it costs, re-analysis runs");

  analysis
    .command("status")
    .description("Pending and failed counts, spend against the cap, Offers on an older analysis")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.GET("/analysis")), statusText);
    });

  analysis
    .command("reanalyze")
    .alias("reanalyse")
    .description("Start a re-analysis run over the Offers on an older analysis (costs money)")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.POST("/analysis/runs")), runText);
    });

  analysis
    .command("run")
    .argument("<id>", "the run's id")
    .description("How far a re-analysis run has got")
    .action(async (id: string) => {
      const { client, send } = ctx.api();
      const reply = await send(
        client.GET("/analysis/runs/{id}", { params: { path: { id: runId(id) } } }),
      );
      ctx.show(reply, runText);
    });
}

export function registerSettings(program: Command, ctx: Ctx): void {
  const settings = program.command("settings").description("Crawl pacing and analysis settings");

  const crawl = settings.command("crawl").description("Pacing and Recheck settings");
  crawl
    .command("show")
    .description("Read them, with the read-only constants")
    .action(async () => {
      const { client, send } = ctx.api();
      showRevisioned(ctx, await send(client.GET("/settings/crawl")), describe);
    });
  revisionOptions(
    crawl
      .command("set")
      .requiredOption(
        "--file <file>",
        "the editable settings as JSON (the constants left out); - for stdin",
      ),
  )
    .description("Replace the pacing and Recheck settings")
    .action(async (opts: RevisionOptions & { file: string }) => {
      const { client, send } = ctx.api();
      const body = (await ctx.readJson(opts.file)) as CrawlSettings;
      const ifMatch = await ifMatchFor(
        ctx,
        opts,
        () => send(client.GET("/settings/crawl")),
        withoutConstants,
      );
      const params = ifMatchHeader(ifMatch);
      showRevisioned(ctx, await send(client.PUT("/settings/crawl", { body, params })), describe);
    });

  const model = settings
    .command("analysis")
    .description("Model, effort, escalation and the Spend cap");
  model
    .command("show")
    .description("Read them, with the price table")
    .action(async () => {
      const { client, send } = ctx.api();
      showRevisioned(ctx, await send(client.GET("/settings/analysis")), describe);
    });
  revisionOptions(
    model.command("set").requiredOption("--file <file>", "the whole settings as JSON; - for stdin"),
  )
    .description("Replace the analysis settings")
    .action(async (opts: RevisionOptions & { file: string }) => {
      const { client, send } = ctx.api();
      const body = (await ctx.readJson(opts.file)) as AnalysisSettings;
      const ifMatch = await ifMatchFor(ctx, opts, () => send(client.GET("/settings/analysis")));
      const params = ifMatchHeader(ifMatch);
      showRevisioned(ctx, await send(client.PUT("/settings/analysis", { body, params })), describe);
    });
}

function withoutConstants(document: unknown): unknown {
  if (typeof document !== "object" || document === null) return document;
  const { constants: _constants, ...rest } = document as Record<string, unknown>;
  return rest;
}

function storageText(storage: Storage): string {
  return describe(storage);
}

export function registerStorage(program: Command, ctx: Ctx): void {
  const storage = program.command("storage").description("What is stored, and deleting it");

  storage
    .command("show")
    .description("Database and snapshot sizes, Offer counts by state, retention constants")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.GET("/storage")), storageText);
    });

  storage
    .command("wipe")
    .requiredOption("--confirm <phrase>", 'the typed confirmation: "delete all Offer data"')
    .description("Delete all Offer data; keeps Profile, Filters, Searches, settings and secrets")
    .action(async (opts) => {
      const { client, send } = ctx.api();
      const reply = await send(
        client.POST("/storage/wipe", {
          body: { confirm: opts.confirm as "delete all Offer data" },
        }),
      );
      ctx.show(reply, (result) => `${describe(result.deleted)}\n\nCrawling is paused.`);
    });
}

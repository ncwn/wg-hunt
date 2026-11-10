import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  type AnalysisProvider,
  DEFAULT_PRICES,
  EFFORTS,
  type Effort,
  type ModelChoice,
} from "@wg-hunt/core";
import { z } from "zod";
import { loadOfferCases, loadPairCases } from "./cases.js";
import type { Price } from "./cost.js";
import { checkSyntheticSet, findProjectRoot, findStrayEvalData, SYNTHETIC_DIR } from "./guard.js";
import {
  exportOverrides,
  localOffersDir,
  localPairsDir,
  localRunsDir,
  readSnapshot,
} from "./overrides.js";
import { compareRuns, describeOutcome, formatRun, type RunResult, readSavedRun } from "./report.js";
import { evaluate, type RunPlan } from "./run.js";

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  createProvider?: (apiKey: string) => AnalysisProvider | Promise<AnalysisProvider>;
};

const USAGE = `Usage:
  pnpm eval [options]                       run rules and the model over the labelled set
  pnpm eval compare <run-a> <run-b>         put two saved runs side by side
  pnpm eval export-overrides <file.json>    turn manual overrides into labels in the local set

Options for a run:
  --set synthetic|local|all     which cases to read (default: synthetic)
  --live                        ask a real model (needs ANTHROPIC_API_KEY, costs money)
  --rules-only                  do not run the model; score rule facts only
  --model <id>                  default claude-haiku-5-5
  --effort <level|none>         default medium; only with --live
  --escalation <off|id[:level]> default: the same model at high
  --input-price <usd>           per million tokens, for a model outside the price table
  --output-price <usd>
  --concurrency <n>             Offers read at once; only with --live (default 4)
  --save                        keep the run in <data folder>/eval/runs/ for \`compare\`
  --out <file>                  also write the run as JSON to this file
  --json                        print the run as JSON instead of the report
Without --live the model's answers are the scripted ones stored with the synthetic cases.
An option that cannot change what was asked for is refused: the model's options with
--rules-only, --effort and --concurrency without --live, any option with a command.

Exit codes: 0 done; 1 the run or its data failed, or no Offer got a model answer (--save and
--out still write the run, which says so); 2 a request that cannot be taken as given.`;

const DEFAULT_MODEL = "claude-haiku-5-5";

class UsageError extends Error {}

/** Logs and errors show project-relative paths only. */
function shown(path: string, root: string): string {
  const rel = relative(root, path);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`)
    ? `<outside project>/${basename(path)}`
    : rel;
}

function effortOf(value: string | undefined, fallback: Effort | null): Effort | null {
  if (value === undefined) return fallback;
  if (value === "none") return null;
  if ((EFFORTS as readonly string[]).includes(value)) return value as Effort;
  throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")} or none`);
}

function escalationOf(value: string | undefined, model: ModelChoice): ModelChoice | null {
  if (value === undefined)
    return { model: model.model, effort: model.effort === null ? null : "high" };
  if (value === "off") return null;
  const [id = "", level] = value.split(":");
  return { model: id, effort: effortOf(level, "high") };
}

const manualOverride = z.object({
  source: z.literal("wg-gesucht"),
  adId: z.string(),
  key: z.string(),
  value: z.unknown(),
  madeOn: z
    .object({ source: z.literal("wg-gesucht"), adId: z.string(), textHash: z.string().nullable() })
    .nullable()
    .optional(),
  adCount: z.number().int().positive().optional(),
  createdAt: z.iso.datetime().optional(),
});

/** Also the answer of the server's `GET /offers/overrides`, so the list can be saved as it is. */
const overridesFile = z.union([
  z.array(manualOverride),
  z.object({ items: z.array(manualOverride) }).transform((answer) => answer.items),
]);

function readRun(name: string, dataDir: string): RunResult {
  const candidates = [resolve(name), join(localRunsDir(dataDir), name)];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (file === undefined) throw new Error(`no saved run named ${name}`);
  try {
    return readSavedRun(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(`${name} is not a run this version can read`);
  }
}

async function defaultProvider(apiKey: string): Promise<AnalysisProvider> {
  const { createAnthropicProvider } = await import("@wg-hunt/core/analysis/anthropic");
  return createAnthropicProvider({ apiKey });
}

const OPTIONS = {
  set: { type: "string" },
  live: { type: "boolean" },
  "rules-only": { type: "boolean" },
  model: { type: "string" },
  effort: { type: "string" },
  escalation: { type: "string" },
  "input-price": { type: "string" },
  "output-price": { type: "string" },
  concurrency: { type: "string" },
  save: { type: "boolean" },
  out: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean" },
} as const;

type Flag = keyof typeof OPTIONS;
type Flags = { [F in Flag]?: string | boolean };

const RUN_FLAGS = (Object.keys(OPTIONS) as Flag[]).filter((flag) => flag !== "help");
const MODEL_FLAGS: readonly Flag[] = [
  "model",
  "effort",
  "escalation",
  "input-price",
  "output-price",
];

const SETS = ["synthetic", "local"] as const;
type SetName = (typeof SETS)[number];

type ModelArgs = { model: ModelChoice; escalation: ModelChoice | null; prices: Price[] };

/**
 * Each member holds only what its command or mode can use, so an option that would do nothing has
 * nowhere to go and is refused while parsing.
 */
type Request =
  | { command: "help" }
  | { command: "compare"; a: string; b: string }
  | { command: "export-overrides"; file: string }
  | ({
      command: "run";
      sets: SetName[];
      save: boolean;
      out: string | undefined;
      json: boolean;
    } & (
      | ({ mode: "live"; concurrency: number } & ModelArgs)
      | ({ mode: "replay" } & ModelArgs)
      | { mode: "rules-only" }
    ));

function refuse(flags: Flags, without: readonly Flag[], why: string): void {
  const given = without.filter((flag) => flags[flag] !== undefined).map((flag) => `--${flag}`);
  if (given.length === 0) return;
  throw new UsageError(`${given.join(", ")} ${given.length === 1 ? "does" : "do"} nothing ${why}`);
}

function concurrencyOf(value: string | undefined): number {
  if (value === undefined) return 4;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`--concurrency must be a whole number of 1 or more, not "${value}"`);
  }
  return Number(value);
}

function modelArgsOf(flags: {
  model?: string;
  effort?: string;
  escalation?: string;
  "input-price"?: string;
  "output-price"?: string;
}): ModelArgs {
  const model: ModelChoice = {
    model: flags.model ?? DEFAULT_MODEL,
    effort: effortOf(flags.effort, "medium"),
  };
  const prices: Price[] = DEFAULT_PRICES.map(({ efforts: _efforts, ...price }) => price);
  if (flags["input-price"] !== undefined || flags["output-price"] !== undefined) {
    const input = Number(flags["input-price"]);
    const output = Number(flags["output-price"]);
    if (!(input >= 0) || !(output >= 0)) {
      throw new UsageError(
        "--input-price and --output-price must be given together, in dollars per million tokens",
      );
    }
    prices.unshift({ model: model.model, inputUsdPerMTok: input, outputUsdPerMTok: output });
  }
  return { model, escalation: escalationOf(flags.escalation, model), prices };
}

function parseRequest(argv: readonly string[]): Request {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help) return { command: "help" };

  if (command === "compare") {
    const [a, b, ...more] = rest;
    if (a === undefined || b === undefined || more.length > 0) {
      throw new UsageError("compare needs two runs");
    }
    refuse(values, RUN_FLAGS, "with compare, which only reads two saved runs");
    return { command, a, b };
  }
  if (command === "export-overrides") {
    const [file, ...more] = rest;
    if (file === undefined || more.length > 0) {
      throw new UsageError("export-overrides needs one JSON file of overrides");
    }
    refuse(values, RUN_FLAGS, "with export-overrides, which only writes labels to the local set");
    return { command, file };
  }
  if (command !== undefined) throw new UsageError(`unknown command ${command}`);

  const setName = values.set ?? "synthetic";
  const sets =
    setName === "all" ? [...SETS] : SETS.includes(setName as SetName) ? [setName as SetName] : null;
  if (sets === null) throw new UsageError("--set must be synthetic, local or all");
  if (values.live && values["rules-only"])
    throw new UsageError("--live and --rules-only cannot be used together");
  const run = {
    command: "run" as const,
    sets,
    save: values.save ?? false,
    out: values.out,
    json: values.json ?? false,
  };

  if (values["rules-only"]) {
    refuse(values, [...MODEL_FLAGS, "concurrency"], "with --rules-only, where no model is asked");
    return { ...run, mode: "rules-only" };
  }
  if (values.live) {
    return {
      ...run,
      mode: "live",
      concurrency: concurrencyOf(values.concurrency),
      ...modelArgsOf(values),
    };
  }
  // Scripted answers stand in for the model: its id still prices the estimate and the escalation
  // setting still decides whether a second answer is read, but the effort changes no answer.
  refuse(values, ["effort", "concurrency"], "without --live, where scripted answers are replayed");
  return { ...run, mode: "replay", ...modelArgsOf(values) };
}

async function planOf(
  request: Extract<Request, { command: "run" }>,
  env: Record<string, string | undefined>,
  io: CliIo,
  onUnexpected: (caseId: string, error: unknown) => void,
): Promise<RunPlan> {
  if (request.mode === "rules-only") return { mode: "rules-only" };
  const { model, escalation, prices } = request;
  const pass = { model, escalation, prices, onUnexpected };
  if (request.mode === "replay") return { mode: "replay", ...pass };
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new UsageError(
      "a live run needs ANTHROPIC_API_KEY in the environment, for example: ANTHROPIC_API_KEY=... pnpm eval --live",
    );
  }
  const provider = await (io.createProvider ?? defaultProvider)(apiKey);
  return { mode: "live", provider, concurrency: request.concurrency, ...pass };
}

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const root = findProjectRoot(import.meta.dirname);
  const dataDir = resolve(root, env.WG_HUNT_DATA_DIR ?? ".data");
  const scrubbed = (message: string) =>
    message.replaceAll(dataDir, shown(dataDir, root)).replaceAll(`${root}${sep}`, "");

  try {
    const request = parseRequest(argv);

    if (request.command === "help") {
      io.out(USAGE);
      return 0;
    }

    if (request.command === "compare") {
      io.out(compareRuns(readRun(request.a, dataDir), readRun(request.b, dataDir)));
      return 0;
    }

    if (request.command === "export-overrides") {
      const overrides = overridesFile.parse(
        JSON.parse(readFileSync(resolve(request.file), "utf8")),
      );
      const result = exportOverrides({
        dataDir,
        overrides,
        readPage: (source, adId) => readSnapshot(dataDir, source, adId),
      });
      for (const id of result.exported)
        io.out(`exported ${id} to ${shown(localOffersDir(dataDir), root)}`);
      for (const skip of result.skipped) {
        io.out(`skipped ${skip.adId} ${skip.key}: ${skip.reason}`);
      }
      const exported = overrides.length - result.skipped.length;
      io.out(
        `exported ${exported} correction${exported === 1 ? "" : "s"}, skipped ${result.skipped.length}`,
      );
      return 0;
    }

    const stray = findStrayEvalData(root);
    if (stray.length > 0) {
      io.err(
        `Evaluation data must live in ${SYNTHETIC_DIR}/ (invented Offers) or in the data folder, not in the repository:\n${stray.map((file) => `  ${file}`).join("\n")}`,
      );
      return 1;
    }
    const problems = checkSyntheticSet(join(root, SYNTHETIC_DIR));
    if (problems.length > 0) {
      io.err(
        `The synthetic set breaks the hygiene rules:\n${problems.map((p) => `  ${p}`).join("\n")}`,
      );
      return 1;
    }

    const { sets } = request;
    const offers = [
      ...(sets.includes("synthetic") ? loadOfferCases(join(root, SYNTHETIC_DIR, "offers")) : []),
      ...(sets.includes("local") ? loadOfferCases(localOffersDir(dataDir)) : []),
    ];
    const pairs = [
      ...(sets.includes("synthetic") ? loadPairCases(join(root, SYNTHETIC_DIR, "pairs")) : []),
      ...(sets.includes("local") ? loadPairCases(localPairsDir(dataDir)) : []),
    ];
    if (
      sets.includes("local") &&
      !sets.includes("synthetic") &&
      offers.length + pairs.length === 0
    ) {
      throw new Error(
        `no local set yet: there are no labelled cases in ${shown(join(dataDir, "eval"), root)}. See CONTRIBUTING.md for how to build one.`,
      );
    }

    const plan = await planOf(request, env, io, (caseId, error) =>
      io.err(
        `${caseId}: reading the model's answer threw, which is a bug and not the model's doing: ${scrubbed(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}`,
      ),
    );
    if (plan.mode === "live") {
      io.err(
        `Live run: ${offers.length} Offers with ${plan.model.model} (${plan.model.effort ?? "no effort"}). This spends real money.`,
      );
    }
    const run = await evaluate({ offers, pairs, sets, plan });

    const json = `${JSON.stringify(run, null, 2)}\n`;
    if (request.out) {
      writeFileSync(resolve(request.out), json);
    }
    if (request.save) {
      const dir = localRunsDir(dataDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const { stamp } = run;
      const version = stamp.mode === "rules-only" ? "" : `-${stamp.analysisVersion}`;
      const name = `${stamp.at.replace(/[:.]/g, "-")}-${stamp.mode}${version}.json`;
      writeFileSync(join(dir, name), json);
      io.err(
        `Saved ${shown(join(dir, name), root)} (compare with: pnpm eval compare ${name} <another>)`,
      );
    }
    io.out(request.json ? json.trimEnd() : formatRun(run));
    if (run.stamp.outcome.state === "complete") return 0;
    io.err(`The run is ${describeOutcome(run)}.`);
    return run.stamp.outcome.state === "model-failed" ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "something went wrong";
    io.err(scrubbed(message));
    if (!(error instanceof UsageError)) return 1;
    io.err("Run `pnpm eval --help` for usage.");
    return 2;
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const code = await main(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exitCode = code;
}

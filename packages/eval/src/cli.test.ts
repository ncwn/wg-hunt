import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { type AnalysisProvider, analysisVersion, ProviderError } from "@wg-hunt/core";
import { emptyOutput } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { type CliIo, main } from "./cli.js";
import { localRunsDir } from "./overrides.js";
import { renderPage } from "./synthetic-page.js";

function harness(env: Record<string, string> = {}, provider?: AnalysisProvider) {
  const dataDir = mkdtempSync(join(tmpdir(), "wg-hunt-cli-"));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(provider ? { createProvider: () => provider } : {}),
  };
  const run = (argv: string[]) => main(argv, { WG_HUNT_DATA_DIR: dataDir, ...env }, io);
  return { dataDir, out, err, run, text: () => out.join("\n") };
}

const live = (provider: AnalysisProvider) =>
  harness({ ANTHROPIC_API_KEY: "sk-ant-test" }, provider);

const answer = {
  output: emptyOutput(),
  usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

function savedRun(dataDir: string) {
  const [name, ...others] = readdirSync(localRunsDir(dataDir));
  expect(others).toEqual([]);
  return JSON.parse(readFileSync(join(localRunsDir(dataDir), name as string), "utf8"));
}

describe("pnpm eval over the synthetic set", () => {
  it("prints per-fact accuracy, the Doubtful rate, the cost and dedupe precision and recall", async () => {
    const h = harness();
    expect(await h.run([])).toBe(0);
    const text = h.text();
    expect(text).toMatch(/rules version \d+, analysis version [0-9a-f]{12}/);
    expect(text).toMatch(/anmeldung\s+model\s+\d+\/\d+\s+\d+\.\d%/);
    expect(text).toMatch(/Doubtful rate: \d+\.\d% \(/);
    expect(text).toMatch(/Cost: \$0\.\d{4} \(/);
    expect(text).toMatch(/duplicate\s+\d+\.\d%\s+\d+\.\d%/);
    expect(text).toMatch(/scripted answers.*not a real model/);
  });

  it("never makes a model call: the Anthropic provider is not even built", async () => {
    const h = harness({ ANTHROPIC_API_KEY: "sk-ant-not-used" });
    let built = 0;
    const code = await main(
      [],
      { WG_HUNT_DATA_DIR: h.dataDir, ANTHROPIC_API_KEY: "sk-ant-not-used" },
      {
        out: () => {},
        err: () => {},
        createProvider: () => {
          built++;
          throw new Error("no");
        },
      },
    );
    expect(code).toBe(0);
    expect(built).toBe(0);
  });

  it("gets the committed baseline right: every rule fact and every scripted model fact", async () => {
    const h = harness();
    await h.run(["--json"]);
    const run = JSON.parse(h.text());
    expect(run.extraction.misses).toEqual([]);
    expect(run.dedupe.misses).toEqual([]);
    expect(run.extraction.cases).toBeGreaterThanOrEqual(25);
    expect(run.dedupe.pairs).toBeGreaterThanOrEqual(12);
  });

  it("scores rules only when asked not to run the model", async () => {
    const h = harness();
    expect(await h.run(["--rules-only"])).toBe(0);
    expect(h.text()).toContain("Doubtful rate: not measured");
    expect(h.text()).not.toMatch(/anmeldung\s+model/);
  });
});

describe("the script behind `pnpm eval`", () => {
  it("runs the command line when started as a script", () => {
    const script = join(import.meta.dirname, "cli.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "--help"], {
      encoding: "utf8",
      cwd: join(import.meta.dirname, "..", "..", ".."),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });
});

describe("exit codes", () => {
  const usageHint = /pnpm eval --help/;

  it.each([
    ["an unknown option", ["--nope"]],
    ["an unknown command", ["frobnicate"]],
    ["a bad --set", ["--set", "mine"]],
    ["compare without two runs", ["compare", "a.json"]],
  ])("answers %s with 2 and points at --help", async (_name, argv) => {
    const h = harness();
    expect(await h.run(argv)).toBe(2);
    expect(h.err.join("\n")).toMatch(usageHint);
  });

  it.each(["abc", "0", "-1", "1.5", ""])("refuses --concurrency %j with 2", async (value) => {
    const h = live({ analyse: async () => answer });
    expect(await h.run(["--live", "--concurrency", value])).toBe(2);
    expect(h.err.join("\n")).toMatch(/--concurrency/);
    expect(h.err.join("\n")).not.toMatch(/does nothing/);
    expect(h.out).toEqual([]);
  });

  it("answers a run that fails with 1, without sending the human to --help", async () => {
    const h = harness();
    const dir = join(h.dataDir, "eval", "offers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.offer.json"), "{ not json");
    expect(await h.run(["--set", "local"])).toBe(1);
    expect(h.err.join("\n")).not.toMatch(usageHint);
  });
});

describe("an option that cannot change what was asked for", () => {
  const refused = async (argv: string[]) => {
    const h = harness();
    const code = await h.run(argv);
    return { code, out: h.out, err: h.err.join("\n"), dataDir: h.dataDir };
  };

  it.each([
    ["--model", ["--rules-only", "--model", "claude-sonnet-5-5"]],
    ["--effort", ["--rules-only", "--effort", "high"]],
    ["--escalation", ["--rules-only", "--escalation", "off"]],
    [
      "--input-price, --output-price",
      ["--rules-only", "--input-price", "1", "--output-price", "2"],
    ],
    ["--concurrency", ["--rules-only", "--concurrency", "2"]],
  ])("is a usage error under --rules-only, where no model is asked: %s", async (flags, argv) => {
    const { code, out, err } = await refused(argv);
    expect(code).toBe(2);
    expect(err).toContain(`${flags} `);
    expect(err).toMatch(/nothing with --rules-only/);
    expect(err).toMatch(/pnpm eval --help/);
    expect(out).toEqual([]);
  });

  it.each([
    ["--effort", ["--effort", "high"]],
    ["--concurrency", ["--concurrency", "2"]],
  ])("is a usage error in a replay, which no %s can reach", async (flag, argv) => {
    const { code, out, err } = await refused(argv);
    expect(code).toBe(2);
    expect(err).toContain(`${flag} does nothing without --live`);
    expect(out).toEqual([]);
  });

  it.each([
    ["--save", ["compare", "a.json", "b.json", "--save"]],
    ["--json", ["compare", "a.json", "b.json", "--json"]],
    ["--out", ["compare", "a.json", "b.json", "--out", "c.json"]],
    ["--set", ["compare", "a.json", "b.json", "--set", "all"]],
    ["--json", ["export-overrides", "overrides.json", "--json"]],
    ["--save", ["export-overrides", "overrides.json", "--save"]],
  ])("is a usage error on a command: %s", async (flag, argv) => {
    const { code, out, err, dataDir } = await refused(argv);
    expect(code).toBe(2);
    expect(err).toContain(`${flag} does nothing with ${argv[0]}`);
    expect(out).toEqual([]);
    expect(existsSync(localRunsDir(dataDir))).toBe(false);
  });

  it("is refused before anything is read, so a missing run is not what the human hears about", async () => {
    const { err } = await refused(["compare", "nope.json", "nope.json", "--save"]);
    expect(err).not.toMatch(/no saved run/);
  });

  it.each([
    ["compare", ["compare", "a.json", "b.json", "c.json"]],
    ["export-overrides", ["export-overrides", "a.json", "b.json"]],
  ])("refuses an argument %s would not read", async (_command, argv) => {
    expect((await refused(argv)).code).toBe(2);
  });

  it("keeps the model's options in a replay where they change the run", async () => {
    const off = harness();
    expect(await off.run(["--escalation", "off", "--json"])).toBe(0);
    expect(JSON.parse(off.text()).extraction.escalated).toBe(0);
    const priced = harness();
    expect(
      await priced.run(["--model", "claude-future-9", "--input-price", "1", "--output-price", "2"]),
    ).toBe(0);
    expect(priced.text()).toMatch(/Cost: \$\d+\.\d{4} \(.*estimated\)/);
  });
});

describe("the opt-in live run", () => {
  it("refuses without ANTHROPIC_API_KEY, and says how", async () => {
    const h = harness();
    expect(await h.run(["--live"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/ANTHROPIC_API_KEY/);
    expect(h.out).toEqual([]);
  });

  it("reads the key from the environment and runs the model it was given", async () => {
    const h = harness({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const seen: string[] = [];
    const code = await main(
      ["--live", "--model", "claude-sonnet-5-5", "--effort", "low", "--escalation", "off"],
      { WG_HUNT_DATA_DIR: h.dataDir, ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        out: (line) => h.out.push(line),
        err: (line) => h.err.push(line),
        createProvider: (key) => {
          seen.push(key);
          return {
            async analyse(request) {
              seen.push(`${request.model}/${request.effort}`);
              return {
                output: emptyOutput(),
                usage: {
                  inputTokens: 2000,
                  outputTokens: 100,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
              };
            },
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(seen[0]).toBe("sk-ant-test");
    expect(seen.slice(1).every((call) => call === "claude-sonnet-5-5/low")).toBe(true);
    expect(h.text()).toContain("live: a real model was asked");
    expect(h.text()).toMatch(/Cost: \$\d+\.\d{4}/);
    expect(h.text() + h.err.join("\n")).not.toContain("sk-ant-test");
  });

  it("says which model has no price instead of guessing a cost", async () => {
    const h = harness({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const code = await main(
      ["--live", "--model", "claude-future-9", "--effort", "none", "--escalation", "off"],
      { WG_HUNT_DATA_DIR: h.dataDir, ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        out: (line) => h.out.push(line),
        err: () => {},
        createProvider: () => ({
          async analyse() {
            return {
              output: emptyOutput(),
              usage: {
                inputTokens: 1_000_000,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            };
          },
        }),
      },
    );
    expect(code).toBe(0);
    expect(h.text()).toContain("Cost: unknown, no price for claude-future-9");
  });

  it("prices a model outside the table from --input-price and --output-price", async () => {
    const h = harness({ ANTHROPIC_API_KEY: "sk-ant-test" });
    await main(
      [
        "--live",
        "--model",
        "claude-future-9",
        "--effort",
        "none",
        "--escalation",
        "off",
        "--input-price",
        "1",
        "--output-price",
        "2",
      ],
      { WG_HUNT_DATA_DIR: h.dataDir, ANTHROPIC_API_KEY: "sk-ant-test" },
      {
        out: (line) => h.out.push(line),
        err: () => {},
        createProvider: () => ({
          async analyse() {
            return {
              output: emptyOutput(),
              usage: {
                inputTokens: 1_000_000,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            };
          },
        }),
      },
    );
    expect(h.text()).toMatch(/Cost: \$30\.0000/);
  });
});

describe("how a live run went", () => {
  it("exits 1 when the key is refused for every Offer, and still saves the run as model-failed", async () => {
    const h = live({
      async analyse() {
        throw new ProviderError("unauthorized");
      },
    });
    expect(await h.run(["--live", "--save"])).toBe(1);
    const run = savedRun(h.dataDir);
    expect(run.stamp.outcome).toEqual({ state: "model-failed", errors: { unauthorized: 30 } });
    expect(run.extraction.modelFailed).toBe(30);
    expect(h.text()).toMatch(/outcome: model-failed.*unauthorized/);
    expect(h.err.join("\n")).toMatch(/no Offer got a model answer/i);
  });

  it("writes --out and prints the run as JSON even when no Offer got an answer", async () => {
    const h = live({
      async analyse() {
        throw new ProviderError("unauthorized");
      },
    });
    const file = join(h.dataDir, "failed.json");
    expect(await h.run(["--live", "--out", file, "--json"])).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).stamp.outcome.state).toBe("model-failed");
    expect(JSON.parse(h.text()).stamp.outcome.state).toBe("model-failed");
  });

  it("exits 0 as partial when the model answered for some Offers and not for others", async () => {
    let calls = 0;
    const h = live({
      async analyse() {
        if (calls++ % 3 === 0) throw new ProviderError("refused");
        return answer;
      },
    });
    expect(await h.run(["--live", "--save", "--escalation", "off", "--concurrency", "1"])).toBe(0);
    const run = savedRun(h.dataDir);
    expect(run.stamp.outcome).toEqual({ state: "partial", errors: { refused: 10 } });
    expect(run.extraction).toMatchObject({ modelRan: 20, modelFailed: 10 });
    expect(h.text()).toMatch(
      /outcome: partial: the model failed on 10 of 30 Offers \(refused 10\)/,
    );
    expect(h.err.join("\n")).toMatch(/The run is partial/);
  });

  it("stamps a run where every Offer got an answer as complete, with nothing on stderr about it", async () => {
    const h = live({ analyse: async () => answer });
    expect(await h.run(["--live", "--save", "--escalation", "off"])).toBe(0);
    expect(savedRun(h.dataDir).stamp.outcome).toEqual({ state: "complete" });
    expect(h.text()).toContain("outcome: complete");
    expect(h.err.join("\n")).not.toMatch(/The run is/);
  });

  it("records an exception that is not the provider's as a failure, and says what it was", async () => {
    const h = live({
      analyse: async () => ({ ...answer, output: null as never }),
    });
    expect(await h.run(["--live", "--json", "--escalation", "off"])).toBe(1);
    expect(JSON.parse(h.text()).stamp.outcome).toEqual({
      state: "model-failed",
      errors: { unexpected: 30 },
    });
    expect(h.err.join("\n")).toMatch(/anmeldung-possible: .*TypeError/);
  });

  it("stamps the replay and the rules-only run as complete", async () => {
    const replay = harness();
    await replay.run(["--json"]);
    expect(JSON.parse(replay.text()).stamp.outcome).toEqual({ state: "complete" });
    const rules = harness();
    await rules.run(["--rules-only", "--json"]);
    expect(JSON.parse(rules.text()).stamp).toMatchObject({
      mode: "rules-only",
      outcome: { state: "complete" },
    });
  });

  it("names no model in a rules-only run's stamp, report or file name", async () => {
    const h = harness();
    expect(await h.run(["--rules-only", "--save"])).toBe(0);
    const run = savedRun(h.dataDir);
    expect(run.stamp).not.toHaveProperty("model");
    expect(run.stamp).not.toHaveProperty("analysisVersion");
    expect(h.text()).not.toMatch(/analysis version|claude-/);
    expect(readdirSync(localRunsDir(h.dataDir))[0]).toMatch(/-rules-only\.json$/);
  });
});

describe("comparing two runs", () => {
  it("saves runs in the data folder and compares two with different analysis versions", async () => {
    const h = harness();
    await h.run(["--save", "--model", "claude-haiku-5-5"]);
    await h.run(["--save", "--model", "claude-sonnet-5-5"]);
    const saved = readdirSync(localRunsDir(h.dataDir)).sort();
    expect(saved).toHaveLength(2);
    h.out.length = 0;
    expect(await h.run(["compare", saved[0] as string, saved[1] as string])).toBe(0);
    const [a, b] = saved.map((name) =>
      JSON.parse(readFileSync(join(localRunsDir(h.dataDir), name), "utf8")),
    );
    expect(a.stamp.analysisVersion).not.toBe(b.stamp.analysisVersion);
    expect(a.stamp.analysisVersion).toBe(
      analysisVersion({ model: a.stamp.model, effort: a.stamp.effort }),
    );
    expect(h.text()).toContain(a.stamp.analysisVersion);
    expect(h.text()).toContain(b.stamp.analysisVersion);
    expect(h.text()).toMatch(/analysis version\s+\S+\s+\S+/);
  });

  it("compares runs given as paths", async () => {
    const h = harness();
    const file = join(h.dataDir, "a.json");
    await h.run(["--out", file, "--json"]);
    h.out.length = 0;
    expect(await h.run(["compare", file, file])).toBe(0);
    expect(h.text()).toContain("Per-fact accuracy");
  });

  it("notes that the model's reads went differently in a complete and a partial run", async () => {
    let calls = 0;
    const flaky = live({
      async analyse() {
        if (calls++ === 0) throw new ProviderError("refused");
        return answer;
      },
    });
    const steady = live({ analyse: async () => answer });
    const argv = ["--live", "--escalation", "off", "--concurrency", "1", "--out"];
    const complete = join(steady.dataDir, "complete.json");
    const partial = join(flaky.dataDir, "partial.json");
    await steady.run([...argv, complete]);
    await flaky.run([...argv, partial]);
    steady.out.length = 0;
    expect(await steady.run(["compare", complete, partial])).toBe(0);
    expect(steady.text()).toMatch(
      /Note: .*A: complete, 0 failed.*B: partial, 1 failed \(refused 1\)/,
    );
    expect(steady.text()).toMatch(/outcome\s+complete\s+partial/);
    expect(steady.text()).toMatch(/failed model reads\s+0\s+1/);
  });

  it("says nothing about outcomes when both runs went the same", async () => {
    const h = harness();
    const file = join(h.dataDir, "a.json");
    await h.run(["--out", file]);
    h.out.length = 0;
    await h.run(["compare", file, file]);
    expect(h.text()).not.toMatch(/Note:/);
  });

  it("still loads and compares a run saved before runs had an outcome, as complete", async () => {
    const h = harness();
    const now = join(h.dataDir, "now.json");
    await h.run(["--out", now]);
    const older = JSON.parse(readFileSync(now, "utf8"));
    delete older.stamp.outcome;
    const before = join(h.dataDir, "before.json");
    writeFileSync(before, JSON.stringify(older));
    h.out.length = 0;
    expect(await h.run(["compare", before, now])).toBe(0);
    expect(h.text()).toMatch(/outcome\s+complete\s+complete/);
    expect(h.text()).not.toMatch(/Note:/);
  });

  it("compares a rules-only run saved with a model in its stamp, as older versions wrote it", async () => {
    const h = harness();
    const now = join(h.dataDir, "now.json");
    await h.run(["--rules-only", "--out", now]);
    const older = JSON.parse(readFileSync(now, "utf8"));
    delete older.stamp.outcome;
    Object.assign(older.stamp, {
      analysisVersion: "25527c37d1aada84",
      model: "claude-haiku-5-5",
      effort: "medium",
      escalation: { model: "claude-haiku-5-5", effort: "high" },
    });
    const before = join(h.dataDir, "before.json");
    writeFileSync(before, JSON.stringify(older));
    h.out.length = 0;
    expect(await h.run(["compare", before, now])).toBe(0);
    expect(h.text()).toMatch(/mode\s+rules-only\s+rules-only/);
  });

  it("explains itself when a run to compare cannot be read", async () => {
    const h = harness();
    expect(await h.run(["compare", "nope.json", "nope.json"])).toBe(1);
    expect(h.err.join("\n")).toMatch(/nope\.json/);
  });
});

describe("the local set of real Offers", () => {
  it("is read from the data folder, beside the synthetic set", async () => {
    const h = harness();
    const dir = join(h.dataDir, "eval", "offers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mine.html"),
      renderPage({
        adId: "9600001",
        title: "Zimmer",
        category: "flatshare-room",
        flatmates: { code: "1w,1m,0d,0n", size: 3 },
        roomSize: 14,
        totalRent: { euros: 500 },
        sections: [["Zimmer", "Ein Zimmer."]],
      }),
    );
    writeFileSync(
      join(dir, "mine.offer.json"),
      JSON.stringify({
        category: "flatshare-room",
        expected: { warmRent: { amount: 500, converted: false } },
      }),
    );
    expect(await h.run(["--set", "all", "--json"])).toBe(0);
    const run = JSON.parse(h.text());
    expect(run.stamp.sets).toEqual(["synthetic", "local"]);
    expect(run.extraction.facts.warmRent.labelled).toBeGreaterThan(30);
  });

  it("names a broken case without an absolute path", async () => {
    const h = harness();
    const dir = join(h.dataDir, "eval", "offers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.offer.json"), "{ not json");
    expect(await h.run(["--set", "local"])).toBe(1);
    const message = h.err.join("\n");
    expect(message).toContain("broken.offer.json");
    expect(message).not.toContain(h.dataDir);
  });

  it("tells how to start one when asked for a set that is not there", async () => {
    const h = harness();
    expect(await h.run(["--set", "local"])).toBe(1);
    expect(h.err.join("\n")).toMatch(/CONTRIBUTING\.md/);
  });

  it("exports manual overrides as labels, reading pages from the data folder", async () => {
    const h = harness();
    const file = join(h.dataDir, "offer-pages", "wg-gesucht", "9600002.html.gz");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      gzipSync(
        renderPage({
          adId: "9600002",
          title: "Zimmer",
          category: "flatshare-room",
          flatmates: { code: "1w,1m,0d,0n", size: 3 },
          roomSize: 14,
          totalRent: { euros: 500 },
          sections: [["Zimmer", "Ein Zimmer."]],
        }),
      ),
    );
    const overrides = join(h.dataDir, "overrides.json");
    writeFileSync(
      overrides,
      JSON.stringify([
        { source: "wg-gesucht", adId: "9600002", key: "anmeldung", value: "possible" },
      ]),
    );
    expect(await h.run(["export-overrides", overrides])).toBe(0);
    expect(h.text()).toContain("wg-gesucht-9600002");
    expect(existsSync(join(h.dataDir, "eval", "offers", "wg-gesucht-9600002.offer.json"))).toBe(
      true,
    );
  });

  it("reads the answer of GET /offers/overrides as it is, so the API's list needs no editing", async () => {
    const h = harness();
    const file = join(h.dataDir, "offer-pages", "wg-gesucht", "9600003.html.gz");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      gzipSync(
        renderPage({
          adId: "9600003",
          title: "Zimmer",
          category: "flatshare-room",
          flatmates: { code: "1w,1m,0d,0n", size: 3 },
          roomSize: 14,
          totalRent: { euros: 500 },
          sections: [["Zimmer", "Ein Zimmer."]],
        }),
      ),
    );
    const overrides = join(h.dataDir, "overrides.json");
    writeFileSync(
      overrides,
      JSON.stringify({
        items: [
          {
            offerId: 7,
            source: "wg-gesucht",
            adId: "9600003",
            key: "scamSignals",
            value: ["keys_by_post"],
            createdAt: "2026-11-04T09:30:00.000Z",
            madeOn: { source: "wg-gesucht", adId: "9600003", textHash: null },
            wordsChanged: null,
            adCount: 2,
          },
          {
            offerId: 7,
            source: "wg-gesucht",
            adId: "9600003",
            key: "anmeldung",
            value: "possible",
            createdAt: "2026-11-04T09:00:00.000Z",
            madeOn: null,
            wordsChanged: null,
            adCount: 2,
          },
        ],
      }),
    );
    expect(await h.run(["export-overrides", overrides])).toBe(0);
    expect(h.text()).toMatch(/skipped 9600003 anmeldung: /);
    expect(h.text()).toMatch(/exported 1 correction, skipped 1$/);
    const labels = JSON.parse(
      readFileSync(join(h.dataDir, "eval", "offers", "wg-gesucht-9600003.offer.json"), "utf8"),
    );
    expect(labels.expected).toEqual({ scamSignals: ["keys_by_post"] });
  });
});

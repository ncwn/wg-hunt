import { describe, expect, it } from "vitest";
import { cliFor, problemOf, type Result, serverWith } from "./harness.js";

const lastLine = (text: string) => text.trimEnd().split("\n").at(-1) ?? "";

const problemCount = (result: Result) =>
  result.stderr.split("\n").filter((line) => line.startsWith("{")).length;

type Wg = ReturnType<typeof cliFor>;
type Listed = { path: string[]; help: string };

const isGroup = ({ help }: Listed) => help.includes("\nCommands:\n");

async function commands(wg: Wg, path: string[] = []): Promise<Listed[]> {
  const help = (await wg(...path, "--help")).stdout;
  const listed = help.split("\nCommands:\n")[1]?.split("\n\n")[0] ?? "";
  const names = [...listed.matchAll(/^ {2}([^\s|]+)/gm)]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "help");
  const below = await Promise.all(names.map((name) => commands(wg, [...path, name])));
  return [{ path, help }, ...below.flat()];
}

describe("a command line that names no command", () => {
  it.each([
    { argv: [], detail: /^wg-hunt needs a command: health, login, doctor, offers, .*watch\.$/ },
    { argv: ["offers"], detail: /^wg-hunt offers needs a command: list, counts, show, / },
    { argv: ["offer"], detail: /^wg-hunt offers needs a command: list, / },
    {
      argv: ["settings", "crawl"],
      detail: /^wg-hunt settings crawl needs a command: show, set\.$/,
    },
    { argv: ["help", "frobnicate"], detail: /^wg-hunt needs a command: / },
  ])("exits 2 with help, then a usage-error problem as the last line: $argv", async (line) => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)(...line.argv);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Usage: wg-hunt /);
    const problem = JSON.parse(lastLine(result.stderr));
    expect(problem).toMatchObject({ type: "usage-error", title: "Usage error" });
    expect(problem.detail).toMatch(line.detail);
    expect(problemCount(result)).toBe(1);
  });

  it.each([
    { argv: ["--json"], env: {} },
    { argv: ["offers", "--json"], env: {} },
    { argv: ["offers"], env: { WG_HUNT_OUTPUT: "json" } },
  ])("writes the problem alone under --json: $argv $env", async ({ argv, env }) => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, { env })(...argv);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${lastLine(result.stderr)}\n`);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "usage-error" });
  });

  it("names a group that takes secrets, and nothing that was typed after it", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("secret", "help", "typed-by-mistake-123");
    expect(result.code).toBe(2);
    expect(JSON.parse(lastLine(result.stderr)).detail).toBe(
      "wg-hunt secret needs a command: list, set, clear.",
    );
    expect(result.stderr).not.toContain("typed-by-mistake-123");
  });

  it("holds for every command group --help lists, so a new group cannot exit 2 silently", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const groups = (await commands(wg)).filter(isGroup);
    expect(groups.length).toBeGreaterThan(10);
    for (const { path } of groups) {
      const named = ["wg-hunt", ...path].join(" ");
      const forPeople = await wg(...path);
      expect(forPeople.code, named).toBe(2);
      expect(JSON.parse(lastLine(forPeople.stderr)), named).toMatchObject({
        type: "usage-error",
        detail: expect.stringContaining(`${named} needs a command: `),
      });
      const json = await wg(...path, "--json");
      expect(json.code, named).toBe(2);
      expect(json.stderr, named).toBe(`${lastLine(forPeople.stderr)}\n`);
    }
  });
});

describe("asking for help or the version", () => {
  it.each([
    ["--help"],
    ["help"],
    ["offers", "--help"],
    ["help", "offers"],
    ["offers", "list", "--help"],
    ["--version"],
  ])("exits 0 and writes no problem: %s %s %s", async (...argv) => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)(...argv);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("a bad --since", () => {
  const TAKERS = [
    ["offers", "list", "--since", "yesterday"],
    ["offers", "counts", "--since", "monday"],
  ];

  it.each(TAKERS)("is a usage error that says what --since takes: %s %s %s %s", async (...argv) => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)(...argv);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const problem = JSON.parse(result.stderr);
    expect(problem).toMatchObject({ type: "usage-error" });
    expect(problem.detail).toMatch(/--since takes .*24h.*2026-11-01/);
  });

  it("is tried on every command that takes --since", async () => {
    const server = await serverWith();
    const takers = (await commands(cliFor(server.runtime)))
      .filter(({ help }) => help.includes("--since <when>"))
      .map(({ path }) => path.join(" "));
    expect(takers, "add the command to TAKERS").toEqual(
      TAKERS.map((argv) => argv.slice(0, -2).join(" ")),
    );
  });
});

describe("every kind of usage error", () => {
  it.each([
    { kind: "an unknown command", argv: ["frobnicate"] },
    { kind: "an unknown command in a group", argv: ["offers", "frobnicate"] },
    { kind: "an unknown option", argv: ["offers", "list", "--frobnicate"] },
    { kind: "an option without its value", argv: ["offers", "list", "--sort"] },
    { kind: "a value an option does not take", argv: ["offers", "list", "--band", "nope"] },
    { kind: "a value an option cannot read", argv: ["offers", "list", "--limit", "many"] },
    { kind: "a missing argument", argv: ["offer", "show"] },
    { kind: "an argument too many", argv: ["crawl", "status", "extra"] },
    { kind: "a missing required option", argv: ["settings", "analysis", "set"] },
    { kind: "no command", argv: [] },
    { kind: "a group without a command", argv: ["offers", "fact"] },
    { kind: "help for a command that is not there", argv: ["help", "frobnicate"] },
    { kind: "a bad --since", argv: ["offers", "list", "--since", "yesterday"] },
    { kind: "an id that is not one", argv: ["searches", "show", "abc"] },
    {
      kind: "options that exclude each other",
      argv: ["searches", "edit", "1", "--enable", "--disable"],
    },
  ])(
    "exits 2 with exactly one usage-error problem, alone under --json: $kind",
    async ({ argv }) => {
      const server = await serverWith();
      const wg = cliFor(server.runtime);

      const forPeople = await wg(...argv);
      expect(forPeople.code).toBe(2);
      expect(forPeople.stdout).toBe("");
      expect(problemOf(forPeople)).toMatchObject({ type: "usage-error", title: "Usage error" });
      expect(problemCount(forPeople)).toBe(1);

      const json = await wg(...argv, "--json");
      expect(json.code).toBe(2);
      expect(json.stdout).toBe("");
      expect(json.stderr).toBe(`${JSON.stringify(problemOf(forPeople))}\n`);
    },
  );
});

describe("the harness", () => {
  it("fails a run that exits non-zero with nothing, or no problem, at the end of stderr", () => {
    expect(() => problemOf({ code: 2, stdout: "", stderr: "" })).toThrow(/exit 2 left no problem/);
    expect(() => problemOf({ code: 2, stdout: "", stderr: "Usage: wg-hunt\n" })).toThrow(
      /left no problem/,
    );
    expect(() =>
      problemOf({ code: 2, stdout: "", stderr: '{"type":"usage-error","title":"x"}\nUsage:\n' }),
    ).toThrow(/left no problem/);
    expect(
      problemOf({ code: 2, stdout: "", stderr: 'Usage:\n{"type":"usage-error","title":"x"}\n' }),
    ).toMatchObject({ type: "usage-error" });
  });
});

import { Command, CommanderError } from "commander";
// The release version is the root package.json's; the CLI package has none of its own.
import release from "../../../package.json" with { type: "json" };
import { registerAccess, registerSystem } from "./commands/access.js";
import { registerAnalysis, registerSettings, registerStorage } from "./commands/analysis.js";
import { registerCrawl } from "./commands/crawl.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerOffers } from "./commands/offers.js";
import { registerSearches } from "./commands/searches.js";
import { registerSeeking } from "./commands/seeking.js";
import { registerWatch } from "./commands/watch.js";
import { type Ctx, createCtx, type GlobalOptions } from "./context.js";
import type { Io } from "./io.js";
import { CliError, EXIT, type Problem } from "./problem.js";

/** Commands whose arguments may hold a secret: a usage error must never repeat what was typed. */
const SECRET_COMMANDS = new Set(["secret", "login", "token"]);

function buildProgram(ctx: Ctx, io: Io): Command {
  const program = new Command("wg-hunt")
    .description("Command line for a wg-hunt server: a thin client of its HTTP API")
    .version(release.version)
    .option("--json", "print the API's JSON unchanged (or set WG_HUNT_OUTPUT=json)")
    .option("--url <url>", "the server's address (or set WG_HUNT_URL)")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      // Commander writes here only the help it shows when no command was named. Under --json
      // that is dropped, so that stderr holds the problem alone.
      writeErr: (text) => {
        if (!ctx.isJson()) io.stderr.write(text);
      },
      // Commander prints no error itself: its message is in the error it throws, and `run` turns
      // that into the problem.
      outputError: () => {},
    })
    .addHelpText(
      "after",
      `
Exit codes: 0 ok, 1 API or problem error, 2 usage error, 3 not found, 4 refused by state
(Bot check Cooldown, spend cap, a Crawl now that waits for a Resume), 5 \`watch --timeout\`
ran out before --count events or before the stream opened. Every non-zero exit writes one problem+json object to stderr; its
\`type\` says which.

Configuration: WG_HUNT_URL and WG_HUNT_TOKEN, or \`wg-hunt login\`. Inside the container the
token is read from the data folder. \`wg-hunt doctor\` says which address and token are in use
and where each came from.`,
    );

  registerSystem(program, ctx);
  registerDoctor(program, ctx);
  registerOffers(program, ctx);
  registerSearches(program, ctx);
  registerCrawl(program, ctx);
  registerSeeking(program, ctx);
  registerAnalysis(program, ctx);
  registerSettings(program, ctx);
  registerStorage(program, ctx);
  registerAccess(program, ctx);
  registerWatch(program, ctx);
  return program;
}

function usageProblem(detail: string): Problem {
  return { type: "usage-error", title: "Usage error", detail };
}

function named(command: Command): Command[] {
  const [first] = command.args;
  const next =
    first === undefined
      ? undefined
      : command.commands.find((sub) => sub.name() === first || sub.aliases().includes(first));
  return next ? [command, ...named(next)] : [command];
}

function usageDetail(err: CommanderError, program: Command, argv: string[]): string {
  // Help shown as an error: a command group, or `wg-hunt` itself, was given no command to run.
  // Only the commands' own names are repeated, so this is safe for a group that takes secrets.
  if (err.code === "commander.help") {
    const path = named(program);
    const commands = (path.at(-1) ?? program).commands.map((sub) => sub.name());
    return `${path.map((command) => command.name()).join(" ")} needs a command: ${commands.join(", ")}.`;
  }
  if (argv.some((arg) => SECRET_COMMANDS.has(arg)))
    return "The command line is not valid. Arguments are not repeated here; see --help.";
  return err.message.replace(/^error: /, "").trim();
}

export async function run(argv: string[], io: Io): Promise<number> {
  let program: Command | undefined;
  const globals = (): GlobalOptions => program?.opts() ?? {};
  const ctx = createCtx(io, globals);
  program = buildProgram(ctx, io);
  try {
    await program.parseAsync(argv, { from: "user" });
    const outcome = ctx.outcome;
    return outcome ? fail(io, ctx, outcome.problem, outcome.exitCode) : EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) return EXIT.ok;
      // Everything else Commander throws is a usage error it has printed no message for. On one
      // line, so that the problem is the last line on stderr when help text comes before it.
      const problem = usageProblem(usageDetail(err, program, argv));
      io.stderr.write(`${JSON.stringify(problem)}\n`);
      return EXIT.usage;
    }
    if (err instanceof CliError) return fail(io, ctx, err.problem, err.exitCode, err.raw);
    // Anything else is a bug; say so without a stack trace, which could hold paths.
    return fail(
      io,
      ctx,
      {
        type: "internal-error",
        title: "The CLI failed unexpectedly",
        detail: err instanceof Error ? err.name : undefined,
      },
      EXIT.error,
    );
  }
}

function fail(io: Io, ctx: Ctx, problem: Problem, exitCode: number, raw?: string): number {
  const text =
    ctx.isJson() && raw ? raw : JSON.stringify(problem, null, ctx.isJson() ? undefined : 2);
  io.stderr.write(`${text}\n`);
  return exitCode;
}

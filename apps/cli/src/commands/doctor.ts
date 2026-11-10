import type { Command } from "commander";
import type { TokenSource, UrlSource } from "../config.js";
import type { Ctx } from "../context.js";
import { pairs } from "../format.js";
import { CliError, cliProblem } from "../problem.js";

/** Flat, with string values only, so that `wg.sh` reads it without a JSON parser. */
type Report = {
  url: string;
  urlSource: UrlSource;
  tokenSource: TokenSource;
  server: "ok" | "no-answer";
  serverVersion?: string;
  signIn: "ok" | "refused" | "no-token" | "not-checked";
};

async function checkServer(ctx: Ctx, report: Report): Promise<CliError | undefined> {
  const { client, send } = ctx.anonymousApi();
  let version: unknown;
  try {
    version = (await send(client.GET("/health"))).data?.version;
  } catch (err) {
    if (err instanceof CliError && err.problem.type === "connection-failed") return err;
  }
  if (typeof version !== "string") {
    return cliProblem(
      "connection-failed",
      "Could not reach the server",
      `${report.url} did not answer /health as a working wg-hunt server does.`,
    );
  }
  report.server = "ok";
  report.serverVersion = version;
  return undefined;
}

async function checkSignIn(ctx: Ctx, report: Report): Promise<CliError | undefined> {
  try {
    ctx.connection();
  } catch (err) {
    report.signIn = "no-token";
    return err as CliError;
  }
  const { client, send } = ctx.api();
  try {
    await send(client.GET("/auth/session"));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    if (err.problem.type === "unauthorized") report.signIn = "refused";
    return err;
  }
  report.signIn = "ok";
  return undefined;
}

export function registerDoctor(program: Command, ctx: Ctx): void {
  program
    .command("doctor")
    .description(
      "Which address and token are used and where each came from, whether the server answers, and whether signing in works (never prints the token)",
    )
    .action(async () => {
      const { url, urlSource, tokenSource } = ctx.looseConnection();
      const report: Report = {
        url,
        urlSource,
        tokenSource,
        server: "no-answer",
        signIn: "not-checked",
      };
      ctx.outcome = (await checkServer(ctx, report)) ?? (await checkSignIn(ctx, report));

      if (ctx.isJson()) {
        const text = JSON.stringify(report);
        ctx.io.stdout.write(ctx.io.stdout.isTTY ? `${text}\n` : text);
        return;
      }
      ctx.io.stdout.write(
        `${pairs([
          ["URL", `${url} (${urlSource})`],
          ["Token", tokenSource],
          ["Server", report.server === "ok" ? `ok, version ${report.serverVersion}` : "no-answer"],
          ["Sign-in", report.signIn],
        ])}\n`,
      );
    });
}

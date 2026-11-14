import type { Command } from "commander";
import { createApi } from "../api/client.js";
import { configPath, writeConfig } from "../config.js";
import type { Ctx } from "../context.js";
import { pairs, table, when } from "../format.js";
import { cliProblem, usageError } from "../problem.js";

async function readSecret(ctx: Ctx, label: string): Promise<string> {
  const { stdin, promptSecret } = ctx.io;
  const value = stdin.isTTY ? await promptSecret(label) : await stdin.read();
  const trimmed = value.trim();
  if (trimmed === "") throw usageError("No value was given.");
  return trimmed;
}

/** A file error's code, such as EACCES, without its message, which holds the path. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown error";
}

function homeRelative(ctx: Ctx, path: string): string {
  const home = ctx.io.homeDir;
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function registerSystem(program: Command, ctx: Ctx): void {
  program
    .command("health")
    .description("Is the server up, and which version (needs no token)")
    .action(async () => {
      const { client, send } = ctx.anonymousApi();
      ctx.show(
        await send(client.GET("/health")),
        (health) => `${health.status}  version ${health.version}`,
      );
    });

  program
    .command("login")
    .description("Save the server's address and access token for later runs")
    .action(async () => {
      const { url } = ctx.looseConnection();
      const token = await readSecret(ctx, "Access token: ");
      const { client, send } = createApi({ url, token, fetch: ctx.io.fetch });
      await send(client.GET("/auth/session"));
      writeConfig(ctx.io, { url, token });
      ctx.note(`Logged in to ${url}. Saved to ${homeRelative(ctx, configPath(ctx.io))}.`);
      if (ctx.io.env.WG_HUNT_TOKEN) {
        ctx.warn(
          "WG_HUNT_TOKEN is set, so the saved token is not used while it is. Unset the variable to use it.",
        );
      }
    });
}

export function registerAccess(program: Command, ctx: Ctx): void {
  const secret = program
    .command("secret")
    .description("Write-only secrets, such as the Anthropic key");

  secret
    .command("list")
    .description("Which secrets are set, each as a masked hint")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.GET("/secrets")), (secrets) =>
        table(
          ["NAME", "SET", "HINT", "UPDATED"],
          secrets.map((s) => [s.name, s.set ? "yes" : "no", s.masked ?? "-", when(s.updatedAt)]),
        ),
      );
    });

  secret
    .command("set")
    .argument("<name>", "the secret's name, such as anthropic")
    .description(
      "Set a secret. The value is read from standard input or a prompt, never from arguments",
    )
    .action(async (name: string) => {
      const value = await readSecret(ctx, `Value for ${name}: `);
      const { client, send } = ctx.api();
      const reply = await send(
        client.PUT("/secrets/{name}", { params: { path: { name } }, body: { value } }),
      );
      ctx.show(reply, (hint) => `${hint.name} is set (${hint.masked ?? "hidden"}).`);
    });

  secret
    .command("clear")
    .argument("<name>", "the secret's name, such as anthropic")
    .description("Clear a secret")
    .action(async (name: string) => {
      const { client, send } = ctx.api();
      const reply = await send(client.DELETE("/secrets/{name}", { params: { path: { name } } }));
      ctx.show(reply, () => `${name} is not set.`);
    });

  const token = program.command("token").description("The access token");

  token
    .command("rotate")
    .option(
      "--print",
      "print the new token (it is shown this once). Under --json the token is left out without it",
    )
    .description("Replace the access token; the old one and every dashboard session stop working")
    .action(async (opts) => {
      const connection = ctx.connection();
      const printed = opts.print === true;
      if (connection.tokenSource === "env" && !printed) {
        throw usageError(
          "The token comes from WG_HUNT_TOKEN, so the new one cannot be saved for you. Run again with --print to see it once, or use `wg-hunt login` instead of the variable.",
        );
      }
      const { client, send } = ctx.api();
      const reply = await send(client.POST("/auth/token/rotate"));
      if (connection.tokenSource === "config") {
        try {
          writeConfig(ctx.io, { url: connection.url, token: reply.data.token });
        } catch (err) {
          // The server has already rotated: the old token is dead and the new one was not saved.
          if (printed) ctx.show(reply, (rotated) => rotated.token);
          throw cliProblem(
            "token-not-saved",
            "The token was rotated but not saved",
            `Saving it to ${homeRelative(ctx, configPath(ctx.io))} failed (${errorCode(err)}). The old token no longer works. The server keeps the new one in its data folder, in the file access-token: run \`wg-hunt login\` with it.`,
          );
        }
      }
      const saved =
        connection.tokenSource === "config"
          ? homeRelative(ctx, configPath(ctx.io))
          : "in the data folder, where this command reads it";
      if (ctx.isJson() && !printed) {
        // Scripts and agents run with --json and keep their output: the new token is not theirs to
        // see unless they ask for it.
        const text = JSON.stringify({ rotated: true, saved });
        ctx.io.stdout.write(ctx.io.stdout.isTTY ? `${text}\n` : text);
        return;
      }
      ctx.show(reply, (rotated) =>
        printed
          ? rotated.token
          : pairs([
              ["Access token", "rotated"],
              ["Saved", saved],
            ]),
      );
    });
}

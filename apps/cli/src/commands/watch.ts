import type { Command } from "commander";
import { refusedTokenAdvice, type SignedConnection } from "../config.js";
import type { Ctx } from "../context.js";
import { inline } from "../format.js";
import { type CliError, cliProblem } from "../problem.js";
import { integer } from "./args.js";

type ServerEvent = { event: string; data: unknown };

async function* readEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  // Closing the reader ends a read that is waiting, which aborting the request alone may not.
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const message = parseMessage(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (message) yield message;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
  }
}

function parseMessage(block: string): ServerEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  const text = data.join("\n");
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: text };
  }
}

type Fields = Record<string, unknown>;

function summary({ event, data }: ServerEvent): string {
  const d = (data ?? {}) as Fields;
  const counts = d.counts as { day?: { used: number; cap: number } } | undefined;
  switch (event) {
    case "crawl-status-changed": {
      const holds = Array.isArray(d.holds) && d.holds.length > 0 ? d.holds.join(", ") : undefined;
      return `crawl ${d.state}${counts?.day ? `, ${counts.day.used} of ${counts.day.cap} requests today` : ""}${holds ? `; waits for a person: ${holds}` : ""}`;
    }
    case "bot-check-cooldown":
      return `Bot check (${d.marker}); Cooldown until ${d.cooldownUntil}${d.needsResume ? ", then a person has to Resume" : ""}`;
    case "offer-added":
      return `new Offer #${d.id} ${inline(d.title)} [${d.band}]`;
    case "offer-band-changed":
      return `Offer #${d.offerId} ${d.previousBand} -> ${d.band}`;
    case "offer-merged":
      return `Offer #${d.offerId} merged into #${d.mergedInto}`;
    case "analysis-progress":
      return `Offer #${d.offerId} ${(d.status as { status?: string } | undefined)?.status ?? d.analysisState}; ${d.awaiting} awaiting analysis`;
    case "analysis-run-progress":
      return `re-analysis run ${d.runId} ${d.status}${d.stopReason ? ` (${d.stopReason})` : ""}: ${d.done} of ${d.total}`;
    case "spend-cap-reached":
      return `Spend cap ${d.state} for ${d.month}: $${d.spentUsd} of $${d.capUsd}, $${d.reservedUsd} reserved`;
    case "spend-cap-cleared":
      return `Spend cap clear for ${d.month}: $${d.spentUsd} of $${d.capUsd}`;
    case "analysis-status-changed": {
      const spend = (d.spend ?? {}) as Fields;
      const older = d.olderVersion as { count?: number } | undefined;
      const run = d.activeRunId == null ? "" : `; re-analysis run ${d.activeRunId} going`;
      return `analysis: key ${d.key}; cap ${spend.state}, $${spend.spentUsd} of $${spend.capUsd}; ${d.awaiting} awaiting; ${older?.count} on an older analysis${run}`;
    }
    case "events-missed":
      return `fell behind: ${d.missed} events were missed; read the Offers and the analysis status again`;
    default:
      return inline(data);
  }
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

// Watching again with the same token gets 401, so this ends the watch as a problem.
function sessionEnded(data: unknown, seen: number, source: SignedConnection["tokenSource"]) {
  const reason = (data as { reason?: unknown } | null)?.reason;
  const why =
    reason === "token-rotated"
      ? "The access token was rotated, so the server closed the stream."
      : `The server closed the stream because its credential ended (${inline(reason)}).`;
  return cliProblem(
    "session-ended",
    "The access token stopped working",
    // The data folder's advice is already to run the command again.
    `${why} ${refusedTokenAdvice(source)}${source === "data-folder" ? "" : " Then watch again."}`,
    { reason, seen },
  );
}

export function registerWatch(program: Command, ctx: Ctx): void {
  program
    .command("watch")
    .description(
      "Tail the live event stream until interrupted; exits 5 if --timeout runs out before --count events (or before the stream opens)",
    )
    .option(
      "--count <n>",
      "stop after this many events (the first is the current crawl status); an events-missed line, printed when the watch fell behind, is not counted; without --json, a crawl status that reads like the last one printed is neither printed nor counted",
      integer("--count", 1),
    )
    .option(
      "--timeout <seconds>",
      "stop after this long (exit 0 without --count, once the stream is open)",
      integer("--timeout", 1),
    )
    .action(async (opts: { count?: number; timeout?: number }) => {
      const { client, send } = ctx.api();
      const timeout = opts.timeout ? AbortSignal.timeout(opts.timeout * 1000) : undefined;
      const signals = [ctx.io.signal, timeout].filter((s): s is AbortSignal => Boolean(s));
      const signal = AbortSignal.any(signals);
      let seen = 0;
      const calledOff = (connected: boolean) => {
        if (!timeout?.aborted || ctx.io.signal?.aborted) return;
        if (connected && !opts.count) return;
        throw cliProblem(
          "watch-timeout",
          "The watch timed out",
          opts.count
            ? `${seen} of ${opts.count} events arrived within ${opts.timeout} seconds.`
            : `The server didn't open the event stream within ${opts.timeout} seconds.`,
          { seen },
        );
      };

      const connecting = send(
        client.GET("/events", {
          parseAs: "stream",
          signal,
          headers: { Accept: "text/event-stream" },
        }),
      );
      const reply = await connecting.catch((err: unknown) => {
        if (signal.aborted) return undefined;
        throw err;
      });
      if (!reply) return calledOff(false);
      if (!reply.data) {
        throw cliProblem(
          "stream-ended",
          "The event stream ended",
          "The server answered without an event stream. Run watch again; `health` says whether the server is up.",
          { seen },
        );
      }

      let ended: CliError | undefined;
      // A status event also comes for what its line leaves out (a queued job, this hour's count),
      // so a line that reads the same is not printed again. As JSON every event is printed.
      let lastStatusLine: string | undefined;
      try {
        for await (const message of readEvents(reply.data, signal)) {
          if (message.event === "session-ended") {
            ended = sessionEnded(message.data, seen, ctx.connection().tokenSource);
            break;
          }
          if (ctx.isJson()) {
            ctx.io.stdout.write(`${JSON.stringify(message)}\n`);
          } else {
            const line = summary(message);
            if (message.event === "crawl-status-changed") {
              // Not printed, so not one of the `--count` events either.
              if (line === lastStatusLine) continue;
              lastStatusLine = line;
            }
            ctx.io.stdout.write(`${clock(ctx.io.now())}  ${message.event}  ${line}\n`);
          }
          // It stands for events that never arrived, so it is none of them.
          if (message.event === "events-missed") continue;
          seen += 1;
          if (opts.count && seen >= opts.count) return;
        }
      } catch (err) {
        if (signal.aborted) return calledOff(true);
        throw cliProblem(
          "stream-reset",
          "The connection to the server was lost",
          `${err instanceof Error ? err.message : "the stream failed"}. Run watch again; \`health\` says whether the server is up.`,
          { seen },
        );
      }
      if (ended) throw ended;
      if (signal.aborted) return calledOff(true);
      throw cliProblem(
        "stream-ended",
        "The event stream ended",
        "The server closed the connection, as it does when it restarts (such as for the daily auto-update). Run watch again.",
        { seen },
      );
    });
}

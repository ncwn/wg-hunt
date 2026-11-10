import type { Command } from "commander";
import type { components } from "../api/schema.js";
import type { Ctx } from "../context.js";
import { describe, pairs, section, settingsStateText, table, when } from "../format.js";
import { integer } from "./args.js";

type CrawlStatus = components["schemas"]["CrawlStatus"];

function nextRequestText(status: CrawlStatus): string | undefined {
  const next = status.nextRequest;
  // An older server sends no `nextRequest`.
  if (next === undefined) return undefined;
  const why = next.waitingFor ? ` (${next.waitingFor})` : "";
  if (next.at !== null) return `${when(next.at)}${why}`;
  return status.holds?.length ? `only after a Resume${why}` : "none queued";
}

function holdsText(status: CrawlStatus): string | undefined {
  // An older server sends no `holds`; its other rows still say as much.
  if (!status.holds?.length) return undefined;
  const now = status.actions?.resume ? "Resume lifts them all" : "Resume once the Cooldown is over";
  return `${status.holds.join(", ")}; ${now}`;
}

type PauseCause = NonNullable<NonNullable<CrawlStatus["paused"]>["cause"]>;

// Typed as a record so that a cause added to the API fails to compile here.
const PAUSE_CAUSES: Record<PauseCause, string> = {
  "unexpected-page":
    "unexpected-page: the Source showed a page wg-hunt could not read. Look for an update before a Resume.",
  "handler-error":
    "handler-error: wg-hunt failed while handling a page. A Resume tries again. If it pauses again, the cause can be the disk, the database, or a page wg-hunt cannot handle: the server's log has the error, and the newest handler-error row of `crawl requests` names the page.",
};

function pauseCauseText(status: CrawlStatus): string | undefined {
  // An older server sends no `cause`, and no other pause has one.
  const cause = status.paused?.cause;
  if (cause === undefined || cause === null) return undefined;
  return PAUSE_CAUSES[cause] ?? cause;
}

function statusText(status: CrawlStatus): string {
  const blocks = [
    pairs([
      ["State", status.state],
      ["Next request", nextRequestText(status)],
      ["Waits for a person", holdsText(status)],
      ["Requests today", `${status.counts.day.used} of ${status.counts.day.cap}`],
      ["Requests this hour", `${status.counts.hour.used} of ${status.counts.hour.cap}`],
      ["Cooldown until", status.cooldown ? when(status.cooldown.until) : undefined],
      ["Cooldown level", status.cooldown?.level],
      [
        "Needs Resume",
        status.cooldown?.needsResume ? "yes, a person has to look first" : undefined,
      ],
      [
        "Paused",
        status.paused ? `${status.paused.reason} since ${when(status.paused.since)}` : undefined,
      ],
      ["Pause cause", pauseCauseText(status)],
      ["Half budget until", status.halfBudgetUntil ? when(status.halfBudgetUntil) : undefined],
      [
        "Last Bot check",
        status.lastBotCheck
          ? `${when(status.lastBotCheck.at)} (${status.lastBotCheck.marker}, ${status.lastBotCheck.hourCount} this hour, ${status.lastBotCheck.dayCount} today)`
          : undefined,
      ],
      ["Settings", settingsStateText(status.settings, "crawl")],
    ]),
  ];
  if (status.nextJobs.length > 0) {
    blocks.push(
      section(
        "Next jobs",
        table(
          ["DUE", "KIND", "PATH"],
          status.nextJobs.map((job) => [when(job.dueAt), job.kind, job.path]),
        ),
      ),
    );
  }
  return blocks.join("\n\n");
}

export function registerCrawl(program: Command, ctx: Ctx): void {
  const crawl = program
    .command("crawl")
    .description("The crawler: status, pause, resume, request log");

  crawl
    .command("status")
    .description("State, today's counts and the next due jobs")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.GET("/crawl")), statusText);
    });

  crawl
    .command("pause")
    .description("Stop after the request in flight, until Resume")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.POST("/crawl/pause")), statusText);
    });

  crawl
    .command("resume")
    .description("Lift a Pause or a stop; refused during a Bot check Cooldown")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.POST("/crawl/resume")), statusText);
    });

  crawl
    .command("requests")
    .description("The request log, newest first")
    .option("--limit <n>", "entries per page", integer("--limit", 1))
    .option("--cursor <cursor>", "the next page, from a previous list")
    .action(async (opts) => {
      const { client, send } = ctx.api();
      const reply = await send(
        client.GET("/crawl/requests", {
          params: {
            query: {
              ...(opts.limit && { limit: opts.limit }),
              ...(opts.cursor && { cursor: opts.cursor }),
            },
          },
        }),
      );
      ctx.show(reply, (page) => {
        const rows = table(
          ["AT", "KIND", "STATUS", "OUTCOME", "MARKER", "PATH"],
          page.items.map((r) => [
            when(r.at),
            r.kind,
            String(r.status ?? "-"),
            r.outcome,
            r.marker ?? "-",
            r.path,
          ]),
        );
        return page.nextCursor ? `${rows}\n\nMore: --cursor ${page.nextCursor}` : rows;
      });
    });

  crawl
    .command("forecast")
    .description("The request budget forecast, for the stored Searches or a draft (--draft)")
    .option("--draft <file>", "a draft { settings, searches } as JSON; - for stdin. Saves nothing")
    .action(async (opts) => {
      const { client, send } = ctx.api();
      const reply = opts.draft
        ? await send(
            client.POST("/crawl/forecast", {
              body: (await ctx.readJson(opts.draft)) as components["schemas"]["ForecastDraft"],
            }),
          )
        : await send(client.GET("/crawl/forecast"));
      ctx.show(reply, describe);
    });
}

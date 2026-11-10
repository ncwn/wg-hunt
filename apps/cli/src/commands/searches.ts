import { type Command, Option } from "commander";
import type { components } from "../api/schema.js";
import type { Ctx } from "../context.js";
import { describe, pairs, table, when } from "../format.js";
import { type CliError, cliProblem, usageError } from "../problem.js";
import { choiceList, integer } from "./args.js";
import { CATEGORIES, RENT_TYPES } from "./choices.js";

type Search = components["schemas"]["Search"];
type Category = Search["categories"][number];
type CrawlNow = components["schemas"]["CrawlNow"];
type WaitReason = NonNullable<CrawlNow["waiting"]>;
type RentType = Search["rentTypes"][number];

function oneLine(search: Search): string[] {
  return [
    String(search.id),
    search.city,
    search.categories.join(","),
    search.priceCeiling === null ? "-" : `€${search.priceCeiling}`,
    `${search.recencyDays}d`,
    search.enabled ? "on" : "off",
    `${search.pollInterval.minMinutes}-${search.pollInterval.maxMinutes} min`,
    search.poll.problem ?? when(search.poll.nextAt),
  ];
}

const searchTable = (items: Search[]) =>
  items.length === 0
    ? "No Searches."
    : table(
        ["ID", "CITY", "CATEGORIES", "CEILING", "WITHIN", "STATE", "POLL EVERY", "NEXT POLL"],
        items.map(oneLine),
        new Set([0]),
      );

function sweepLine(sweep: Search["sweep"]): string {
  const what = sweep.mode === "backfill" ? "Backfill" : "Sweep";
  switch (sweep.status) {
    case "idle":
      return "none (the Search is off or can't be read)";
    case "scheduled":
      return sweep.mode === "backfill"
        ? `Backfill queued, starts ${when(sweep.startAt)}`
        : `next Sweep at ${when(sweep.startAt)}`;
    case "running":
      return `${what} in progress, ${sweep.pagesRead} ${sweep.pagesRead === 1 ? "page" : "pages"} read`;
  }
}

function searchDetail(search: Search): string {
  return pairs([
    ["ID", search.id],
    ["Source", search.source],
    ["City", search.city],
    ["Categories", search.categories.join(", ")],
    ["Rent types", search.rentTypes.join(", ")],
    ["Price ceiling", search.priceCeiling === null ? "none" : `€${search.priceCeiling}`],
    ["Online within", `${search.recencyDays} days`],
    ["Enabled", search.enabled],
    ["Poll every", `${search.pollInterval.minMinutes}-${search.pollInterval.maxMinutes} minutes`],
    ["Next poll", search.poll.nextAt ? when(search.poll.nextAt) : undefined],
    ["Problem", search.poll.problem],
    ["Sweep", sweepLine(search.sweep)],
    ["Last Sweep", search.sweep.lastFinishedAt ? when(search.sweep.lastFinishedAt) : undefined],
    ["Updated", when(search.updatedAt)],
  ]);
}

type SearchOptions = {
  city?: string;
  cityId?: string;
  category?: string[];
  rentType?: string[];
  priceCeiling?: number | false;
  recencyDays?: number;
  enabled?: boolean;
  pollMin?: number;
  pollMax?: number;
};

function pollInterval(opts: SearchOptions) {
  if (opts.pollMin === undefined && opts.pollMax === undefined) return undefined;
  if (opts.pollMin === undefined || opts.pollMax === undefined) {
    throw usageError("--poll-min and --poll-max go together.");
  }
  return { minMinutes: opts.pollMin, maxMinutes: opts.pollMax };
}

function changes(opts: SearchOptions) {
  const interval = pollInterval(opts);
  return {
    ...(opts.city !== undefined && { city: opts.city }),
    ...(opts.cityId !== undefined && { cityId: opts.cityId }),
    ...(opts.category && { categories: opts.category as Category[] }),
    ...(opts.rentType && { rentTypes: opts.rentType as RentType[] }),
    ...(opts.priceCeiling === false && { priceCeiling: null }),
    ...(typeof opts.priceCeiling === "number" && { priceCeiling: opts.priceCeiling }),
    ...(opts.recencyDays !== undefined && { recencyDays: opts.recencyDays }),
    ...(opts.enabled !== undefined && { enabled: opts.enabled }),
    ...(interval && { pollInterval: interval }),
  };
}

function withSearchOptions(command: Command, { forAdd }: { forAdd: boolean }): Command {
  command
    .addOption(
      new Option(
        "--category <category...>",
        "flatshare-room, one-room-flat, flat, house",
      ).argParser(choiceList("--category", CATEGORIES)),
    )
    .addOption(
      new Option("--rent-type <type...>", "unlimited, limited, overnight").argParser(
        choiceList("--rent-type", RENT_TYPES),
      ),
    )
    .option("--city-id <id>", "the Source's id for the city, when its name is not recognised")
    .option(
      "--recency-days <n>",
      "only Offers online within this many days",
      integer("--recency-days", 1),
    )
    .option("--poll-min <minutes>", "shortest time between polls", integer("--poll-min", 1))
    .option("--poll-max <minutes>", "longest time between polls", integer("--poll-max", 1));
  if (forAdd) {
    command
      .requiredOption("--city <name>", "the city to search")
      .option("--price-ceiling <eur>", "a loose ceiling for the price", integer("--price-ceiling"))
      .option("--disabled", "add it switched off");
  } else {
    command
      .option("--city <name>", "the city to search")
      .option("--price-ceiling <eur>", "a loose ceiling for the price", integer("--price-ceiling"))
      .option("--no-price-ceiling", "remove the price ceiling")
      .option("--enable", "switch it on")
      .option("--disable", "switch it off");
  }
  return command;
}

export function registerSearches(program: Command, ctx: Ctx): void {
  const searches = program
    .command("searches")
    .alias("search")
    .description("Searches: what gets crawled");

  searches
    .command("list")
    .description("List the Searches")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.GET("/searches", { params: { query: { limit: 200 } } })), (page) =>
        searchTable(page.items),
      );
    });

  searches
    .command("show")
    .argument("<id>", "the Search's id")
    .description("Read one Search")
    .action(async (id: string) => {
      const { client, send } = ctx.api();
      const reply = await send(
        client.GET("/searches/{id}", { params: { path: { id: searchId(id) } } }),
      );
      ctx.show(reply, searchDetail);
    });

  withSearchOptions(
    searches.command("add").description("Add a Search (its first poll runs at once)"),
    {
      forAdd: true,
    },
  ).action(async (opts: SearchOptions & { disabled?: boolean }) => {
    if (!opts.category?.length) throw usageError("Give at least one --category.");
    const { client, send } = ctx.api();
    const body = {
      ...changes(opts),
      city: opts.city as string,
      categories: opts.category as Category[],
      ...(opts.disabled && { enabled: false }),
    };
    ctx.show(await send(client.POST("/searches", { body })), searchDetail);
  });

  withSearchOptions(
    searches
      .command("edit")
      .argument("<id>", "the Search's id")
      .description("Change a Search; only the options you give change"),
    { forAdd: false },
  ).action(async (id: string, opts: SearchOptions & { enable?: boolean; disable?: boolean }) => {
    if (opts.enable && opts.disable) throw usageError("--enable and --disable cannot go together.");
    const enabled = opts.enable ? true : opts.disable ? false : undefined;
    const body = changes({ ...opts, ...(enabled !== undefined && { enabled }) });
    if (Object.keys(body).length === 0) throw usageError("Give at least one thing to change.");
    const { client, send } = ctx.api();
    const reply = await send(
      client.PATCH("/searches/{id}", { params: { path: { id: searchId(id) } }, body }),
    );
    ctx.show(reply, searchDetail);
  });

  searches
    .command("remove")
    .alias("delete")
    .argument("<id>", "the Search's id")
    .description("Delete a Search")
    .action(async (id: string) => {
      const { client, send } = ctx.api();
      const reply = await send(
        client.DELETE("/searches/{id}", { params: { path: { id: searchId(id) } } }),
      );
      ctx.show(reply, () => `Search ${id} deleted.`);
    });

  searches
    .command("crawl-now")
    .argument("<id>", "the Search's id")
    .description("Make the Search's poll due now; exits 4 if only a person's Resume lets it run")
    .action(async (id: string) => {
      const { client, send } = ctx.api();
      const reply = await send(
        client.POST("/searches/{id}/crawl-now", { params: { path: { id: searchId(id) } } }),
      );
      ctx.show(
        reply,
        (result) =>
          `${result.message}\n${describe({ queued: result.queued, runsAt: result.runsAt, waiting: result.waiting })}`,
      );
      const outcome = crawlNowOutcome(reply.data);
      if (outcome) ctx.outcome = outcome;
    });
}

function searchId(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw usageError(`"${text}" is not a Search id.`);
  return Number(text);
}

/**
 * A Cooldown ends by itself, unless a Resume has to follow it, which the server says by giving no
 * time (`runsAt` null).
 */
export const CRAWL_NOW_WAITS = {
  gap: "runs-by-itself",
  "hourly-cap": "runs-by-itself",
  "daily-cap": "runs-by-itself",
  "active-hours": "runs-by-itself",
  cooldown: "runs-by-itself",
  "needs-resume": "needs-resume",
  paused: "needs-resume",
  "layout-changed": "needs-resume",
  "disk-full": "needs-resume",
  wiped: "needs-resume",
} as const satisfies Record<WaitReason, string>;

function crawlNowOutcome(
  result: Pick<CrawlNow, "waiting" | "runsAt" | "message">,
): CliError | undefined {
  if (result.waiting === null) return undefined;
  const kind = CRAWL_NOW_WAITS[result.waiting];
  const needsResume = kind === "needs-resume" || result.runsAt === null;
  if (!needsResume) return undefined;
  return cliProblem(
    "crawl-waits-for-resume",
    "Crawl now waits for a Resume",
    `${result.message} The poll is queued, but it runs only after a person resumes the crawl.`,
    { waiting: result.waiting },
  );
}

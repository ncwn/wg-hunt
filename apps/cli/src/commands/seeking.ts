import type { Command } from "commander";
import type { components } from "../api/schema.js";
import type { Ctx } from "../context.js";
import { describe, inline, section, table, truncate } from "../format.js";
import { usageError } from "../problem.js";
import { BANDS } from "./choices.js";
import {
  ifMatchFor,
  ifMatchHeader,
  type RevisionOptions,
  revisionOptions,
  showRevisioned,
} from "./revision.js";

type Filters = components["schemas"]["Filters"];
type SeekerProfile = components["schemas"]["SeekerProfile"];
type SeekingOptions = {
  profile?: string;
  filters?: string;
  profileBase?: string;
  profileIfMatch?: string;
  filtersBase?: string;
  filtersIfMatch?: string;
};
type Preview = components["schemas"]["RankingPreview"];

function filtersTable(filters: Filters): string {
  return table(
    ["FILTER", "ON", "STRENGTH", "SETTINGS"],
    Object.entries(filters).map(([name, filter]) => {
      const { enabled, strength, ...rest } = filter as Record<string, unknown>;
      return [
        name,
        enabled ? "yes" : "no",
        String(strength),
        Object.entries(rest)
          .map(([key, value]) => `${key}=${truncate(inline(value), 40)}`)
          .join(" "),
      ];
    }),
  );
}

function previewText(preview: Preview): string {
  const counts = table(
    ["BAND", "BEFORE", "AFTER"],
    BANDS.map((band) => [
      band,
      String(preview.counts.before[band]),
      String(preview.counts.after[band]),
    ]),
    new Set([1, 2]),
  );
  if (preview.changes.length === 0) return `${counts}\n\nNo Offer would change band.`;
  return `${counts}\n\n${section(
    "Would change band",
    table(
      ["OFFER", "FROM", "TO", "TITLE"],
      preview.changes.map((c) => [String(c.offerId), c.from, c.to, truncate(c.title, 50)]),
      new Set([0]),
    ),
  )}`;
}

export function registerSeeking(program: Command, ctx: Ctx): void {
  const profile = program.command("profile").description("The Seeker Profile and its Places");

  profile
    .command("show")
    .description("Read the Seeker Profile")
    .action(async () => {
      const { client, send } = ctx.api();
      showRevisioned(ctx, await send(client.GET("/profile")), describe);
    });

  revisionOptions(
    profile
      .command("set")
      .requiredOption(
        "--file <file>",
        "the whole Profile as JSON (as `profile show --json` prints it); - for stdin",
      ),
  )
    .description("Replace the Seeker Profile and rank every Offer again")
    .action(async (opts: RevisionOptions & { file: string }) => {
      const { client, send } = ctx.api();
      const body = (await ctx.readJson(opts.file)) as components["schemas"]["SeekerProfile"];
      const ifMatch = await ifMatchFor(ctx, opts, () => send(client.GET("/profile")));
      const params = ifMatchHeader(ifMatch);
      showRevisioned(ctx, await send(client.PUT("/profile", { body, params })), describe);
    });

  const filters = program.command("filters").description("The active Filter set");

  filters
    .command("show")
    .description("Read the Filters")
    .action(async () => {
      const { client, send } = ctx.api();
      showRevisioned(ctx, await send(client.GET("/filters")), filtersTable);
    });

  revisionOptions(
    filters
      .command("set")
      .requiredOption(
        "--file <file>",
        "the whole Filter set as JSON (as `filters show --json` prints it); - for stdin",
      ),
  )
    .description("Replace the Filters and rank every Offer again")
    .action(async (opts: RevisionOptions & { file: string }) => {
      const { client, send } = ctx.api();
      const body = (await ctx.readJson(opts.file)) as Filters;
      const ifMatch = await ifMatchFor(ctx, opts, () => send(client.GET("/filters")));
      const params = ifMatchHeader(ifMatch);
      showRevisioned(ctx, await send(client.PUT("/filters", { body, params })), filtersTable);
    });

  program
    .command("seeking")
    .description("The Seeker Profile and the Filters together")
    .command("set")
    .option(
      "--profile <file>",
      "the whole Profile as JSON (as `profile show --json` prints it); - for stdin",
    )
    .option(
      "--filters <file>",
      "the whole Filter set as JSON (as `filters show --json` prints it); - for stdin",
    )
    .option(
      "--profile-base <file>",
      "the `profile show --json` output the change started from: refused (exit 4) if it is no longer current",
    )
    .option(
      "--profile-if-match <revision>",
      "refuse (exit 4) unless the revision printed by `profile show` is still current",
    )
    .option(
      "--filters-base <file>",
      "the `filters show --json` output the change started from: refused (exit 4) if it is no longer current",
    )
    .option(
      "--filters-if-match <revision>",
      "refuse (exit 4) unless the revision printed by `filters show` is still current",
    )
    .description(
      "Replace the Profile, the Filters or both in one write and rank every Offer again once; how a Place the distance Filter measures from is renamed or removed",
    )
    .action(async (opts: SeekingOptions) => {
      if (opts.profile === undefined && opts.filters === undefined) {
        throw usageError("Give --profile, --filters or both.");
      }
      const { client, send } = ctx.api();
      const profileRevision = await ifMatchFor(
        ctx,
        { base: opts.profileBase, ifMatch: opts.profileIfMatch },
        () => send(client.GET("/profile")),
        undefined,
        { base: "--profile-base", ifMatch: "--profile-if-match" },
      );
      const filtersRevision = await ifMatchFor(
        ctx,
        { base: opts.filtersBase, ifMatch: opts.filtersIfMatch },
        () => send(client.GET("/filters")),
        undefined,
        { base: "--filters-base", ifMatch: "--filters-if-match" },
      );
      const body: components["schemas"]["SeekingChanges"] = {
        ...(opts.profile !== undefined && {
          profile: (await ctx.readJson(opts.profile)) as SeekerProfile,
        }),
        ...(opts.filters !== undefined && {
          filters: (await ctx.readJson(opts.filters)) as Filters,
        }),
        revisions: {
          ...(profileRevision !== undefined && { profile: profileRevision }),
          ...(filtersRevision !== undefined && { filters: filtersRevision }),
        },
      };
      const reply = await send(client.PUT("/seeking", { body }));
      ctx.show(
        reply,
        (saved) =>
          `${section("Seeker Profile", describe(saved.profile))}\n\n${section("Filters", filtersTable(saved.filters))}`,
      );
      ctx.note(
        `Revisions: profile ${reply.data.revisions.profile}, filters ${reply.data.revisions.filters}`,
      );
    });

  program
    .command("ranking")
    .description("Ranking previews")
    .command("preview")
    .requiredOption("--file <file>", "a draft { profile?, filters? } as JSON; - for stdin")
    .description("Which Offers would change band under a draft; saves nothing")
    .action(async (opts) => {
      const { client, send } = ctx.api();
      const body = (await ctx.readJson(
        opts.file,
      )) as components["schemas"]["RankingPreviewRequest"];
      ctx.show(await send(client.POST("/ranking/preview", { body })), previewText);
    });

  program
    .command("preset")
    .description("The fictional example preset")
    .command("example")
    .description("The example Profile, Filters and Search as a draft; applies nothing")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.GET("/presets/example")), describe);
    });
}

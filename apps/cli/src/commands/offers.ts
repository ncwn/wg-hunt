import { type Command, Option } from "commander";
import type { components } from "../api/schema.js";
import type { Ctx } from "../context.js";
import { describe, euro, inline, pairs, section, table, truncate, when } from "../format.js";
import { usageError } from "../problem.js";
import { findOffer, integer, type Offer, sinceInstant } from "./args.js";
import { BANDS, CATEGORIES, SORTS } from "./choices.js";

type Summary = components["schemas"]["OfferSummary"];

function rent(offer: Summary): string {
  const { warmRent } = offer.keyFacts;
  if (!warmRent) return "-";
  return `${warmRent.converted ? "~" : ""}${euro(warmRent.amount)}`;
}

function marks(offer: Summary): string {
  return [
    offer.marks.shortlisted && "shortlisted",
    offer.marks.contacted && "contacted",
    offer.marks.dismissed && "dismissed",
  ]
    .filter(Boolean)
    .join(",");
}

function hiddenCauses(offer: Summary): string | undefined {
  const causes = offer.visibility.hidden.map((hidden) => {
    const kind = hidden.cause === "stale" ? `stale (${hidden.why})` : hidden.cause;
    const since = hidden.since === null ? "" : ` since ${when(hidden.since)}`;
    return `${kind}${since}, until ${hidden.endsWhen}`;
  });
  return causes.length === 0 ? undefined : causes.join("; ");
}

function whyNot(offer: Summary): string {
  const open = offer.reasons.filter((reason) => reason.outcome !== "pass");
  return [...new Set(open.map((reason) => reason.filter))].join(",");
}

function offerTable(items: Summary[]): string {
  if (items.length === 0) return "No Offers.";
  return table(
    ["ID", "BAND", "RENT", "M2", "DISTRICT", "FROM", "TITLE", "ISSUES", "MARKS"],
    items.map((offer) => [
      String(offer.id),
      offer.band,
      rent(offer),
      String(offer.keyFacts.size ?? "-"),
      truncate(offer.keyFacts.district ?? "-", 18),
      offer.keyFacts.availableFrom ?? "-",
      truncate(offer.title, 44),
      whyNot(offer) || "-",
      marks(offer) || "-",
    ]),
    new Set([0, 2, 3]),
  );
}

function offerDetail(offer: Offer): string {
  const blocks: string[] = [];
  blocks.push(`#${offer.id}  ${offer.title}  [${offer.band}]`);
  blocks.push(
    pairs([
      ["URL", offer.url],
      ["Category", offer.category],
      ["Rent", rent(offer)],
      ["Size", offer.keyFacts.size === null ? undefined : `${offer.keyFacts.size} m²`],
      ["District", offer.keyFacts.district],
      ["Available from", offer.keyFacts.availableFrom],
      ["First seen", when(offer.firstSeenAt)],
      ["Band since", when(offer.bandChangedAt)],
      ["Page", offer.pageStatus],
      ["Hidden because", hiddenCauses(offer)],
      ["Marks", marks(offer)],
      ["Analysis", analysisLine(offer)],
      ["Retention", retentionLine(offer)],
    ]),
  );
  if (offer.scam.likelyScam || offer.scam.signals.length > 0 || offer.scam.mark) {
    blocks.push(
      section(
        offer.scam.likelyScam ? "Likely scam" : "Scam signals",
        [
          offer.scam.summary,
          offer.scam.mark ? `Your mark: ${offer.scam.mark}` : "",
          ...offer.scam.signals.map(
            (signal) => `${signal.strength}  ${signal.message}${quote(signal.quote)}`,
          ),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  }
  if (offer.reasons.length > 0) {
    blocks.push(
      section(
        `Why ${offer.band}`,
        table(
          ["", "FILTER", "WHY"],
          offer.reasons.map((reason) => [
            reason.outcome,
            `${reason.filter} (${reason.strength})`,
            `${reason.message}${quote(reason.quote)}`,
          ]),
        ),
      ),
    );
  }
  if (offer.chips.length > 0) {
    blocks.push(
      section("Notes", offer.chips.map((chip) => `${chip.label}${quote(chip.quote)}`).join("\n")),
    );
  }
  const facts = Object.entries(offer.facts);
  if (facts.length > 0) {
    blocks.push(
      section(
        "Facts",
        table(
          ["FACT", "VALUE", "ORIGIN", "NOTE"],
          facts.flatMap(([name, fact]) =>
            (Array.isArray(fact) ? fact : [fact]).map((item) => [
              name,
              truncate(inline(item.value), 40),
              item.origin,
              item.confidence?.status === "doubtful"
                ? `doubtful: ${item.confidence.reasons.join("; ")}`
                : "",
            ]),
          ),
        ),
      ),
    );
  }
  blocks.push(
    section(
      "Ad IDs",
      table(
        ["SOURCE", "AD ID", "STATUS", "LAST BUMP", "URL"],
        offer.ads.map((ad) => [ad.source, ad.adId, ad.pageStatus, when(ad.lastBumpAt), ad.url]),
      ),
    ),
  );
  if (offer.priceHistory.length > 0) {
    blocks.push(
      section(
        "Price history",
        table(
          ["WHEN", "AD ID", "WARM RENT"],
          offer.priceHistory.map((p) => [when(p.observedAt), p.adId, euro(p.warmRent)]),
        ),
      ),
    );
  }
  if (offer.siblings.length > 0) {
    blocks.push(
      section("Siblings", offer.siblings.map((s) => `#${s.offer.id}  ${s.offer.title}`).join("\n")),
    );
  }
  if (offer.cloned.length > 0) {
    blocks.push(
      section(
        "Cloned links",
        offer.cloned.map((c) => `#${c.offer.id}  ${c.offer.title}  (${c.role})`).join("\n"),
      ),
    );
  }
  return blocks.join("\n\n");
}

function analysisLine(offer: Offer): string {
  const { state, model, effort, escalated } = offer.analysis;
  const how = [model, effort, escalated ? "escalated" : ""].filter(Boolean).join(", ");
  const { status, reason, at, next } = offer.analysisStatus;
  const why = [reason, at ? when(at) : ""].filter(Boolean).join(", ");
  const now = `${status}${why ? ` (${why})` : ""}${next === "none" ? "" : `, next: ${next}`}`;
  return `${how ? `${state} (${how})` : state}; ${now}`;
}

function retentionLine(offer: Offer): string {
  const { state, keptBecause, recordExpiresAt, snapshotExpiresAt } = offer.retention;
  const kept = keptBecause.join(", ");
  if (state === "not-quiet") return kept ? `not quiet; kept once quiet by ${kept}` : "not quiet";
  const snapshots = `snapshots due ${when(snapshotExpiresAt)}`;
  if (state === "kept") return `kept by ${kept}; ${snapshots}`;
  return `record due ${when(recordExpiresAt)}; ${snapshots}`;
}

const quote = (text: string | undefined) => (text ? `  "${truncate(text, 80)}"` : "");

export function registerOffers(program: Command, ctx: Ctx): void {
  const offers = program
    .command("offers")
    .alias("offer")
    .description("Offers: list, read, mark, correct, recheck, merge");

  offers
    .command("list")
    .description("List ranked Offers, band by band")
    .addOption(new Option("--band <band>", "only this band").choices(BANDS))
    .addOption(new Option("--sort <sort>", "order inside each band").choices(SORTS))
    .option(
      "--since <when>",
      "only Offers new or in a new band since: 90m, 24h, 7d, or a Berlin date",
    )
    .addOption(new Option("--category <category>", "only this category").choices(CATEGORIES))
    .option("--place <name>", "with --sort distance: the Place to measure from")
    .option("--include-hidden", "also list the Hidden band")
    .option("--shortlisted", "only shortlisted Offers, from every band, Hidden too")
    .option("--limit <n>", "Offers per page (the API's default is 50)", integer("--limit", 1))
    .option("--cursor <cursor>", "the next page, from a list with the same --sort and --place")
    .action(async (opts) => {
      const { client, send } = ctx.api();
      const reply = await send(
        client.GET("/offers", {
          params: {
            query: {
              ...(opts.band && { band: opts.band }),
              ...(opts.sort && { sort: opts.sort }),
              ...(opts.since && { since: sinceInstant(opts.since, ctx.io.now()) }),
              ...(opts.category && { category: opts.category }),
              ...(opts.place && { place: opts.place }),
              ...(opts.includeHidden && { includeHidden: "true" as const }),
              ...(opts.shortlisted && { shortlisted: "true" as const }),
              ...(opts.limit && { limit: opts.limit }),
              ...(opts.cursor && { cursor: opts.cursor }),
            },
          },
        }),
      );
      ctx.show(reply, (page) =>
        page.nextCursor
          ? `${offerTable(page.items)}\n\nMore: --cursor ${page.nextCursor}`
          : offerTable(page.items),
      );
    });

  offers
    .command("counts")
    .description("How many Offers each band holds, and how many are new")
    .option("--since <when>", "count as new those since: 90m, 24h, 7d, or a Berlin date")
    .action(async (opts) => {
      const { client, send } = ctx.api();
      const reply = await send(
        client.GET("/offers/counts", {
          params: {
            query: { ...(opts.since && { since: sinceInstant(opts.since, ctx.io.now()) }) },
          },
        }),
      );
      ctx.show(reply, (counts) =>
        pairs([...Object.entries(counts.bands), ["new", counts.new]] as [string, number][]),
      );
    });

  offers
    .command("show")
    .argument("<offer>", "an Offer id, an Ad ID (ad:<id>), or an Offer page URL")
    .description("Read one Offer: facts, reasons, Scam signals, Ad IDs, price history")
    .action(async (ref: string) => {
      ctx.show(await findOffer(ctx, ref), offerDetail);
    });

  offers
    .command("mark")
    .argument("<offer>", "an Offer id, an Ad ID (ad:<id>), or an Offer page URL")
    .description("Dismiss, shortlist or mark contacted; override the Likely scam verdict")
    .option("--dismissed", "mark Dismissed (hidden, re-posts included)")
    .option("--no-dismissed", "take Dismissed away")
    .option("--shortlisted", "shortlist")
    .option("--no-shortlisted", "take it off the shortlist")
    .option("--contacted", "mark contacted")
    .option("--no-contacted", "take contacted away")
    .addOption(
      new Option(
        "--scam <verdict>",
        "scam: Likely scam; not: not one; clear: your mark away",
      ).choices(["scam", "not", "clear"]),
    )
    .action(async (ref: string, opts) => {
      const body = {
        ...(opts.dismissed !== undefined && { dismissed: opts.dismissed as boolean }),
        ...(opts.shortlisted !== undefined && { shortlisted: opts.shortlisted as boolean }),
        ...(opts.contacted !== undefined && { contacted: opts.contacted as boolean }),
        ...(opts.scam && { scam: opts.scam as "scam" | "not" | "clear" }),
      };
      if (Object.keys(body).length === 0) {
        throw usageError(
          "Give at least one mark: --dismissed, --shortlisted, --contacted or --scam (or their --no- forms).",
        );
      }
      const { client, send } = ctx.api();
      const { data } = await findOffer(ctx, ref);
      const reply = await send(
        client.PATCH("/offers/{id}/marks", { params: { path: { id: data.id } }, body }),
      );
      ctx.show(
        reply,
        (offer) => `#${offer.id}  ${offer.title}  [${offer.band}]  ${marks(offer) || "no marks"}`,
      );
    });

  const fact = offers.command("fact").description("Correct an Offer Fact by hand, or take it back");

  fact
    .command("set")
    .argument("<offer>", "an Offer id, an Ad ID (ad:<id>), or an Offer page URL")
    .argument("<fact>", "the fact's name, such as anmeldung or warmRent")
    .argument(
      "<value>",
      'its value as JSON, such as 550, \'{"amount":550,"converted":false}\' or unknown',
    )
    .description("Set a fact's value by hand; it wins over the rules and the model")
    .action(async (ref: string, name: string, value: string) => {
      const { client, send } = ctx.api();
      const { data } = await findOffer(ctx, ref);
      const reply = await send(
        client.PUT("/offers/{id}/facts/{fact}", {
          params: { path: { id: data.id, fact: name } },
          body: { value: parseValue(value) },
        }),
      );
      ctx.show(reply, (offer) => `#${offer.id}  ${name} set by hand  [${offer.band}]`);
    });

  fact
    .command("revert")
    .argument("<offer>", "an Offer id, an Ad ID (ad:<id>), or an Offer page URL")
    .argument("<fact>", "the fact's name")
    .description("Take a manual correction away")
    .action(async (ref: string, name: string) => {
      const { client, send } = ctx.api();
      const { data } = await findOffer(ctx, ref);
      const reply = await send(
        client.DELETE("/offers/{id}/facts/{fact}", {
          params: { path: { id: data.id, fact: name } },
        }),
      );
      ctx.show(reply, (offer) => `#${offer.id}  ${name} back to what was read  [${offer.band}]`);
    });

  offers
    .command("recheck")
    .argument("<offer>", "an Offer id, an Ad ID (ad:<id>), or an Offer page URL")
    .description("Queue one Recheck of the Offer's page; it runs on the crawler's pacing")
    .action(async (ref: string) => {
      const { client, send } = ctx.api();
      const { data } = await findOffer(ctx, ref);
      const reply = await send(
        client.POST("/offers/{id}/recheck", { params: { path: { id: data.id } } }),
      );
      ctx.show(reply, (queued) => queued.message);
    });

  offers
    .command("reanalyze")
    .alias("reanalyse")
    .argument("<offer>", "an Offer id, an Ad ID (ad:<id>), or an Offer page URL")
    .description("Run the model pass on one Offer again (costs money)")
    .action(async (ref: string) => {
      const { client, send } = ctx.api();
      const { data } = await findOffer(ctx, ref);
      const reply = await send(
        client.POST("/offers/{id}/reanalyze", { params: { path: { id: data.id } } }),
      );
      ctx.show(reply, (accepted) => `Offer ${accepted.offerId} is queued for analysis.`);
    });

  offers
    .command("merge")
    .argument("<offer>", "the Offer that stays")
    .argument("<other>", "the Offer that is the same room; it folds into the first")
    .description("Say another Offer is the same room as this one")
    .action(async (ref: string, otherRef: string) => {
      const { client, send } = ctx.api();
      const { data } = await findOffer(ctx, ref);
      const other = await findOffer(ctx, otherRef);
      const reply = await send(
        client.POST("/offers/{id}/merge", {
          params: { path: { id: data.id } },
          body: { offerId: other.data.id },
        }),
      );
      ctx.show(
        reply,
        (merged) => `#${merged.id}  ${merged.title} now holds ${merged.ads.length} Ad IDs`,
      );
    });

  offers
    .command("split")
    .argument("<offer>", "an Offer id, an Ad ID (ad:<id>), or an Offer page URL")
    .argument("<ad-id>", "the Ad ID that is not the same room")
    .description("Take an Ad ID out of an Offer, into an Offer of its own")
    .action(async (ref: string, adId: string) => {
      const { client, send } = ctx.api();
      const { data } = await findOffer(ctx, ref);
      const reply = await send(
        client.POST("/offers/{id}/split", { params: { path: { id: data.id } }, body: { adId } }),
      );
      ctx.show(reply, (result) => describe(result));
    });

  offers
    .command("release")
    .argument("<offer>", "an Offer id, an Ad ID (ad:<id>), or an Offer page URL")
    .description(
      "Let the record expire despite its merge and split verdicts (keeps the verdicts and the marks)",
    )
    .action(async (ref: string) => {
      const { client, send } = ctx.api();
      const { data } = await findOffer(ctx, ref);
      const reply = await send(
        client.POST("/offers/{id}/retention/release", { params: { path: { id: data.id } } }),
      );
      ctx.show(reply, (offer) => `#${offer.id}  Retention: ${retentionLine(offer)}`);
    });

  offers
    .command("overrides")
    .description("Every manual fact correction, as evaluation labels")
    .action(async () => {
      const { client, send } = ctx.api();
      ctx.show(await send(client.GET("/offers/overrides")), (list) =>
        list.items.length === 0
          ? "No manual corrections."
          : table(
              ["OFFER", "AD ID", "FACT", "VALUE"],
              list.items.map((o) => [String(o.offerId), o.adId, o.key, inline(o.value)]),
            ),
      );
    });
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

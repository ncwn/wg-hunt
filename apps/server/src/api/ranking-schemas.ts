import { z } from "@hono/zod-openapi";
import {
  BANDS,
  CAUSES,
  CHIP_KINDS,
  CHIP_TONES,
  EFFECTS,
  FILTER_KEYS,
  HIDDEN_CAUSES,
  OUTCOMES,
  STRENGTHS,
} from "@wg-hunt/core";

export const bandSchema = z.enum(BANDS).openapi("Band", {
  description:
    "`match` passes every Filter on evidence that checked out; `near-match` misses only Wants, or rests on unknown, Doubtful or incomplete evidence; `warned` is a Likely scam; `hidden` fails a Dealbreaker on a known value, is Stale, Untracked or Dismissed.",
});

const reasonSchema = z
  .object({
    filter: z.enum(FILTER_KEYS),
    strength: z.enum(STRENGTHS),
    outcome: z.enum(OUTCOMES).openapi({
      description: "`pass` is a ✓, `warn` a ⚠ (weak evidence or inside a margin), `fail` a ✗.",
    }),
    effect: z.enum(EFFECTS).openapi({ description: "What this reason does to the Offer's band." }),
    cause: z.enum(CAUSES),
    message: z.string().openapi({ description: "A sentence for the seeker." }),
    quote: z.string().optional().openapi({
      description: "The Offer's own words (or field and value) the reason rests on.",
    }),
  })
  .openapi("Reason");

const chipSchema = z
  .object({
    kind: z.enum(CHIP_KINDS),
    tone: z.enum(CHIP_TONES),
    label: z.string(),
    quote: z.string().optional(),
    evidence: z.string().optional().openapi({
      description: "What a rule compared, for a chip that rests on a rule such as a Scam signal.",
    }),
  })
  .openapi("Chip");

export const rankingFields = {
  band: bandSchema,
  bandChangedAt: z.iso.datetime().openapi({
    description:
      "When the Offer entered its current band (a move that only time causes is recorded by the next read, or within a few minutes); for a new Offer, when it was made. `since` returns Offers that entered their band after a time.",
  }),
  reasons: z.array(reasonSchema).openapi({
    description: "One reason per evaluated Filter.",
  }),
  chips: z.array(chipSchema),
  hiddenBecause: z.enum(HIDDEN_CAUSES).nullable().openapi({
    description:
      "Set when the Offer is hidden whatever the Filters say: the first of `visibility.hidden`. Its reasons are still given.",
  }),
};

const since = z.iso.datetime().nullable();

const hiddenCauseSchema = z
  .discriminatedUnion("cause", [
    z.object({
      cause: z.literal("stale"),
      why: z.enum(["aged", "deactivated", "deleted"]).openapi({
        description:
          "`aged`: no Ad ID with a live page was Bumped for more than 7 days. `deactivated`: no page is live and at least one is deactivated. `deleted`: every page was deleted.",
      }),
      since: since.openapi({
        description: "When the last live Ad ID aged out; null for a deactivated or deleted page.",
      }),
      endsWhen: z.enum(["bumped", "reactivated", "reposted"]).openapi({
        description:
          "What makes it shown again: a Bump seen by a poll or Sweep, the page live again on a Recheck, or a re-post that collapses into the Offer.",
      }),
    }),
    z.object({
      cause: z.literal("untracked"),
      since: since.openapi({
        description: "When it went Untracked. Not recorded yet, so always null.",
      }),
      endsWhen: z.literal("a-search-matches").openapi({
        description: "An enabled Search lists one of its Ad IDs again.",
      }),
    }),
    z.object({
      cause: z.literal("dismissed"),
      since: since.openapi({ description: "When the seeker marked it not for me." }),
      endsWhen: z.literal("undismissed").openapi({ description: "The seeker takes the mark off." }),
    }),
  ])
  .openapi("HiddenCause");

export const visibilitySchema = z
  .object({
    hidden: z.array(hiddenCauseSchema).openapi({
      description:
        "Every cause that hides the Offer whatever the Filters say, in precedence order (stale, untracked, dismissed); empty when none does. The band is always `hidden` when this is not empty.",
    }),
    actions: z.object({
      recheck: z.boolean().openapi({
        description:
          "A Recheck may be asked for: the current Ad ID is Tracked. `POST /offers/{id}/recheck` refuses with `offer-untracked` otherwise.",
      }),
      undismiss: z.boolean().openapi({
        description: "The Offer is Dismissed, so the mark can be taken off.",
      }),
    }),
  })
  .openapi("OfferVisibility", {
    description:
      "What hides the Offer, since when, what ends each cause, and what the seeker may do.",
  });

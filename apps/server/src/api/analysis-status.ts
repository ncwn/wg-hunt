import { z } from "@hono/zod-openapi";
import { ANALYSIS_NEXT, ANALYSIS_STATUSES } from "../analysis/status.js";

const statusKind = z.enum(ANALYSIS_STATUSES).openapi("AnalysisStatusKind", {
  description: [
    "Where the Offer's analysis stands. Read without anyone acting (`willRead`): `reading` (a call is in flight), `queued` (sent at the next cycle, including a Re-analyse click not yet served), `in-batch` (its request waits for or is inside a batch, since `at`), `provisional` (the first pass is shown while the escalation pass waits in a batch, since `at`), `words-changed` (the words changed since it was read; the next cycle reads them again), `waiting-for-in-flight` (the calls and batches in flight hold the rest of the spend cap; it is read once they settle). A request a batch holds is read whatever the cap says, but not without a key: it is `waiting-for-key` or `key-refused` then.",
    "Waiting: `retry-at` (the last attempt failed with `reason`; the next is at `at`), `waiting-for-cap` (the month's spend cap is reached, or what is left of it does not pay for this Offer's own call; it resets at `at`), `waiting-for-key` (no Anthropic key), `key-refused` (the API refused the key that is set), `waiting-for-page` (not read yet, and no readable page is stored, `reason`; once a Recheck stores one it is read like any Offer), `needs-click` (the last attempt failed with `reason` in a way trying again would only repeat: it waits for new words or Re-analyse).",
    "Read: `analyzed` (current), `kept-previous` (the last attempt failed with `reason`; the previous result is kept), `escalation-lost` (the first pass is shown but its escalation pass is gone, with `reason` when a failure ended it), `older-version` (read at an older analysis version; only a re-analysis run reads it again), `stale` (Stale Offers are never read).",
    "A page failure (`reason` is `no_stored_page` or `unreadable_page`) says the stored page of the Offer's current Ad ID is missing or cannot be read, so nothing was sent. It ends as soon as the current Ad ID's stored page reads, whether a Recheck stored one or the Offer moved to another Ad ID whose page is stored, and nothing is read because of that alone: `kept-previous` becomes `analyzed` or `older-version`, `escalation-lost` stays and waits for Re-analyse, and a `waiting-for-page` Offer waits to be read like any other.",
  ].join(" "),
});

export const analysisStatusSchema = z
  .object({
    status: statusKind,
    next: z.enum(ANALYSIS_NEXT).openapi({
      description:
        "What moves it on: `none`, `wait` (it moves on by itself), `add-key`, `replace-key`, `raise-cap` (or wait until `at`; with `at` null, for what is in flight to settle), `reanalyze` (`POST /offers/{id}/reanalyze`), `start-run` (`POST /analysis/runs`), `recheck` (`POST /offers/{id}/recheck`). A status that waits for a click or a run (`needs-click`, `kept-previous`, `escalation-lost`, `older-version`) says `add-key`, `replace-key` or `raise-cap` instead while the server would refuse that click or run. `kept-previous` and `escalation-lost` say `recheck` while a page failure stands, whatever the key and the cap: a Re-analyse would fail on the same stored page at once.",
    }),
    reason: z.string().nullable().openapi({
      description: "The error kind behind a failed status, such as `overloaded`; null otherwise.",
    }),
    at: z.iso.datetime().nullable().openapi({
      description:
        "Since when (`in-batch`, `provisional`), when the next attempt is made (`retry-at`), or when the cap resets (`waiting-for-cap`, and `next: raise-cap` while the cap is reached); null otherwise.",
    }),
    willRead: z.boolean().openapi({
      description:
        "It will be read without anyone doing anything. `awaiting` in `GET /analysis` counts these.",
    }),
  })
  .openapi("OfferAnalysisStatus");

export const analysisStatusCounts = z
  .object(Object.fromEntries(ANALYSIS_STATUSES.map((s) => [s, z.number().int()])))
  .openapi("AnalysisStatusCounts", { description: "Offers in each analysis status." });

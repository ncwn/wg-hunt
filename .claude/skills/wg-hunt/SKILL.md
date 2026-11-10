---

name: wg-hunt
description: Work with the user's self-hosted wg-hunt, which crawls wg-gesucht.de room Offers and ranks them for one Seeker Profile. Use for the room hunt itself - what's new, a pasted wg-gesucht.de link, tuning Filters or the Profile, setting up Searches, dismissing or shortlisting Offers, or why crawling stopped.
---

# wg-hunt

wg-hunt is a crawler plus a ranking over **Offers** (one room each, however many Ad IDs it was posted under). Offers sit in bands, **Match**, **Near match**, **Warned** and **Hidden**, each with reasons and the quote behind every fact. This folder needs nothing else.

Two ideas make most requests easy to place:

- A **Search** decides what is crawled and costs requests. A **Filter** decides what is shown and costs nothing, so a Filter change can be previewed freely.
- Facts are read once from each Offer. Reading, ranking and previewing are free; what costs requests or money is a Search, a Recheck, a Re-analyse, a re-analysis run.

## Reaching it

Use `scripts/wg.sh` in this folder (run it by its full path). It finds a route (the `wg-hunt` CLI on PATH, then `docker compose exec` into a running project, then plain `curl`), says which one on stderr, warns if CLI and server differ in major version, and always passes `--json`, so stdout is the server's JSON.

The CLI and `curl` reach the address given: `WG_HUNT_URL`, else the one `wg-hunt login` saved, else this machine. A container reaches only the instance on this machine, so it is a route only when that address is this machine's (none given, `127.0.0.1`, `localhost`, `[::1]`); `WG_HUNT_ROUTE=compose` uses it whatever the address.

```sh
wg.sh offers list --band match --since 24h   # any wg-hunt command; `wg.sh offers --help` lists a group's
wg.sh api GET '/offers?band=match'           # one API call over curl, when there is no CLI route
wg.sh ops crawl                              # the API's operations, from its OpenAPI document
wg.sh doctor                                 # route, versions, the address and token in use, signing in
```

Run `doctor` first: if the route is `curl`, there is no CLI, so the flows' commands become `api` calls (`offers list` is `GET /offers`; `ops` lists them all). Otherwise prefer the CLI's commands over `api` because they resolve a pasted URL or Ad ID for you (`GET /offers/lookup?url=` does it over curl). If `doctor` finds no route, tell the human how to start it (`docker compose up -d`) or where `WG_HUNT_URL` points. On a CLI route it also says where the address and the token came from and whether signing in works; when signing in fails it exits 1 with the problem on stderr.

When a command answers `unauthorized`, `session-ended` or `not-configured`, the CLI has no working token for that address. On a CLI route, the `detail` of `unauthorized` and `session-ended` says where the token came from and what fixes it, and that of `not-configured` says how to give it one. Over curl, `unauthorized` is the server's own problem, which cannot know where the token came from; `doctor`'s `token:` line says. Prefer passing that to the human over forcing another route, because a container on this machine may be a different instance from the one the address names.

Every route exits with the same codes. A non-zero exit writes one problem+json line to stderr (wg.sh's own notes start with `wg-hunt:`). Read its `type` rather than guessing from the code:

| Exit | Means                                                                                       | `type` on stderr                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | done                                                                                        | none                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 1    | an error: no route, no or a wrong token, the server failed, the event stream ended or broke | `connection-failed`, `not-configured`, `unauthorized`, `invalid-token`, `internal-error`, `stream-ended`, `stream-reset`, `session-ended`, `token-not-saved`, ...                                                                                                                                                                                                                                                               |
| 2    | bad request: the command line or the input                                                  | `usage-error`, `validation-error`, `invalid-body`, `invalid-cursor`                                                                                                                                                                                                                                                                                                                                                             |
| 3    | not found                                                                                   | `not-found`, `not-known` (no Search has matched that Ad ID), `offer-merged` (the Offer was merged: carry on with its `mergedInto`)                                                                                                                                                                                                                                                                                              |
| 4    | refused by the state wg-hunt is in; nothing changed unless noted                            | `bot-check-cooldown`, `wipe-running`, `search-disabled`, `unknown-city`, `offer-untracked`, `no-api-key`, `api-key-refused`, `analysis-in-batch`, `spend-cap-reached`, `analysis-run-active`, `nothing-to-reanalyze` (no Offer is on an older analysis), `offer-has-one-ad`, `stale-revision` (a `set` with a base or if-match, or a revision in the body, whose document changed since it was shown), `crawl-waits-for-resume` |
| 5    | `watch --timeout` ran out before `--count` events, or before the stream opened              | `watch-timeout` (with `seen`)                                                                                                                                                                                                                                                                                                                                                                                                   |

`crawl-waits-for-resume` is the one exit 4 where the request went through: the poll is queued, but only a person's Resume lets it run (`runsAt` is null); the body is on stdout. A `type` not listed here comes from a newer server; its HTTP status decides (409 is 4).

## Typical flows

Skip, reorder or merge them; they are what requests usually look like. Details and commands are in [flows.md](flows.md).

| The human says                                               | Flow                              |
| ------------------------------------------------------------ | --------------------------------- |
| "anything new?", "how is it going?"                          | **Check in**, then **What's new** |
| "what came in since Monday?"                                 | **What's new**                    |
| pastes a wg-gesucht.de link, "what about this one?"          | **Look at an Offer**              |
| "stop showing me X", "I can live with Y"                     | **Tune**                          |
| "I'm looking for a room in Z", first run                     | **Set up**                        |
| "dismiss that", "that's the same flat", "that is not a scam" | **Curate**                        |
| "why did it stop?", "nothing new for hours"                  | **Troubleshoot**                  |

## The only absolute rules

These five guard safety and consent. Everything else is judgement.

1. **Reach wg-gesucht.de only through wg-hunt.** For fresher data, use `offers recheck` or `searches crawl-now`. A direct fetch adds traffic outside the pacing and can bring a Bot check down on the whole instance.
2. **Resume after a Bot check, Cooldown or "layout changed" pause only with the human's say-so for that pause.** Earlier approval does not carry over. Resuming re-sends requests to a site that just challenged it.
3. **Ask before changing what is crawled, shown or spent**: Searches, Profile, Filters, crawl and analysis settings, re-analysis runs, the data wipe. Show the preview, forecast or cost first, then apply on a yes.
4. **Touch secrets only on a specific request** (`secret`, `token rotate`), and never echo a value. The human types their own keys. `token rotate` saves the new token itself; never add `--print`, which shows it.
5. **Personal data stays local.** Profile details and Offer content do not go into commits, issues, PRs or any other public place.

## Habits that help

- Quote the evidence. Reasons come with `quote` fields; showing them lets the human judge a call faster than any summary.
- A fact marked Doubtful or unknown is a question, not a verdict. Say so, and suggest asking the Advertiser.
- Faster crawling raises the chance of a Bot check, which stops everything for hours. When asked for more speed, prefer the smallest change that meets the need, show its forecast, and name that risk.
- Marks, fact corrections, merge and split are the human's own curation: do them when asked, say what changed and how to undo it.
- Dates are Berlin time in the app; `--since` takes `90m`, `24h`, `7d` or a date.
- Say what you assumed (a time window, a default) in one line so the human can correct it.

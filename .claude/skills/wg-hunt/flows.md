# Flows

`wg.sh` below is `scripts/wg.sh` in this folder. All output is JSON; read it with `jq` if present, otherwise by eye. Draft files go in `mktemp`, not in the repo.

## Check in

Goal: the human knows the state of the hunt and what is waiting on them.

```sh
wg.sh crawl status       # state, holds, nextRequest, actions, today's counts, settings
wg.sh analysis status    # key, awaiting, byStatus, spend vs cap, olderVersion, actions, settings
wg.sh offers counts --since 24h
```

`state` is one of `running`, `paused`, `cooling-down`, `needs-resume`, `outside-hours`, `layout-changed`, `disk-full`, `wiped`, but it names only the first thing holding the crawl. Prefer the fields the server works out for you over reading `state` and `cooldown` together:

- `holds`: every stop only a person lifts (`paused`, `layout-changed`, `disk-full`, `wiped`, `needs-resume`), now or once a Cooldown is over. Empty means the crawl carries on by itself.
- `nextRequest`: `at` is when the next request is expected and `waitingFor` what holds it back. `at` is null while only a Resume lets requests go, including during a Cooldown that a Resume must follow.
- `actions`: whether `pause` and `resume` would do anything now. `resumeRefusedBy` names the problem a Resume would be refused with now (`bot-check-cooldown`, `wipe-running`), null when it would not be.

Both statuses carry `settings`. Its `source` is `saved`, `default` (nothing saved) or `partly-unreadable`: the saved settings stopped parsing, after an upgrade say, and the fields in `unreadable` went back to their default while the rest kept their saved value. Name those fields to the human, since a default cap or pace may not be what they chose. Saving the settings again ends it (`settings crawl set` or `settings analysis set` with the document `show` prints, or Keep these settings on the dashboard's Settings page).

For analysis, read `byStatus` (how many Offers are in each analysis status) and `key` rather than `counts`: `pending` and `failed` mix Offers that are being read with ones that wait for a person. `awaiting` counts only what will be read without anyone acting. Each Offer carries the same status as `analysisStatus` (`status`, `reason`, `at`, `next`); `next` says what moves it on, so don't work it out from `analysisState`.

Waiting on the human means a non-empty `holds` (their call to Resume, see Troubleshoot), or Offers in an analysis status whose `next` is theirs: `waiting-for-key` (`key: "absent"`) or `key-refused` (`key: "refused"`): a key to add or replace; `waiting-for-cap` (`spend.state` is `reached`, or what is left does not pay for this Offer's own call): raise the cap, or wait until `at`; `needs-click`, `kept-previous`, `escalation-lost`: Re-analyse, which costs a call; `waiting-for-page`: a Recheck; `older-version` (`olderVersion.count`): a re-analysis run that costs money. For those four, go by `next`, not the status: while it says `add-key`, `replace-key` or `raise-cap`, the click or run would be refused, so name that blocker first (`raise-cap` with `at` null means what is in flight holds the cap for now). `kept-previous` and `escalation-lost` say `recheck` instead when `reason` is `no_stored_page` or `unreadable_page`: the stored page is gone or unreadable, so a Re-analyse would fail on it at once, and `offers recheck <id>` is what moves it on. The Recheck costs a request and no call. Once the Offer's current Ad ID has a readable stored page the failure is gone and nothing was read: a kept result is `analyzed` again (or `older-version`), and a lost escalation then says `reanalyze`. `reason: outcome_not_stored` on `needs-click` or `kept-previous` means a call was made and paid for but its result could not be saved (the database took no write, as on a full disk): say so before offering the Re-analyse, which pays for that call a second time. `retry-at` waits by itself until `at`, and `waiting-for-in-flight` until the calls in flight settle, minutes; neither needs the human. Report the state in one sentence, list what waits and the choice it needs; change nothing.

## What's new

Goal: Matches and Near matches since a time, each with its reasons and quotes.

If the human gave no time, ask, or take the last 24 h and say so.

```sh
wg.sh offers list --since 24h --band match
wg.sh offers list --since 24h --band near-match
```

`--since` returns Offers that are new or entered their current band since then. Each item has `keyFacts` (rent, size, district, available from) and `reasons`; a reason with `outcome` other than `pass` is what keeps a Near match from being a Match, and its `quote` is the Offer's own words. Present Matches first, then Near matches with what is missing; mention Warned only as a count. Use `offers show <id>` for one the human wants to dig into.

## Look at an Offer

Goal: the human knows whether to write to this Advertiser, and what to say.

```sh
wg.sh offers show 'https://www.wg-gesucht.de/<page>.html'   # or an Offer id, or ad:<Ad ID>
```

Read: band and `reasons`, `facts` with quotes, `scam` (one strong or three soft signals make a Likely scam; fewer soft ones are cautions), Doubtful facts, `priceHistory`, `siblings` and `cloned` links, and `visibility`: every cause hiding it (`hidden[]`: Stale aged / deactivated / deleted, Untracked, Dismissed, each with `since` and `endsWhen`) and whether a Recheck may be asked for (`actions.recheck`). Tell the human what would bring it back rather than rechecking a page that cannot change it.

After `offers recheck <id>`, prefer reading `recheck` on `offers show` over guessing, because Rechecks go last and can take a while. While `recheck.state` is `queued` or `in-flight` it hasn't run yet; a Bot check doesn't lose it, it stays `queued` until the Cooldown is over. Once it's `idle` again with a newer `pageFetchedAt`, the Offer shows the page as it is now. `failed` means no usable page came back; `retryAfter` says when an automatic Recheck may try again.

On `not-known` (exit 3), say so rather than fetching the page; the human can paste the text, or widen a Search (Set up).

Suggest questions for the Advertiser from what is unknown or Doubtful (Anmeldung not stated, minimum stay unclear, a Requirement that touches the Profile). Draft a short message in the Offer's language for the human to send themselves, using the Profile's facts. Mark it contacted (`offers mark <id> --contacted`) after they say they sent it.

## Tune

Goal: a request such as "I can live with 650 rent" or "stop caring about distance" becomes a Profile or Filter change the human has seen the effect of.

```sh
wg.sh filters show > shown.json         # likewise: profile show
cp shown.json filters.json              # edit this copy: a Filter has enabled, strength (dealbreaker hides, want moves to Near match), a limit, a margin
jq '{filters: .}' filters.json > draft.json                  # draft body: { "profile"?, "filters"? }
wg.sh ranking preview --file draft.json                      # counts before / after, Offers that change band
```

Show the counts and the titles that move, then ask. On a yes: `wg.sh filters set --file filters.json --base shown.json` (or `profile set`, `settings crawl set`, `settings analysis set`, or `seeking set --profile … --filters …` when the draft changes both the Profile and the Filters). They replace the whole document, so edit the copy and keep `shown.json` unedited for `--base`. On `stale-revision` (it changed meanwhile, in the dashboard, say), show again, redo the change, and confirm before setting it. Over curl, keep the `revision` that `wg.sh api GET /filters` notes on stderr and write the edited file with `wg.sh api --if-match <revision> PUT /filters - < filters.json`: `api` takes the JSON itself or `-` for stdin, never a file name. Check with `offers counts` afterwards. A change to what is crawled is a Search change (Set up).

Renaming the Place the distance Filter measures from takes one write of both documents, because `profile set` alone refuses it at `places` and `filters set` alone at `distance.place`. Removing that Place can also be two writes (`filters set` with `distance.place` null, then `profile set`), but prefer one `seeking set`, which ranks the Offers again once:

```sh
wg.sh profile show > profile-shown.json && cp profile-shown.json profile.json   # rename the Place here
wg.sh filters show > filters-shown.json && cp filters-shown.json filters.json   # and in distance.place here (null when removing it)
jq -n --slurpfile p profile.json --slurpfile f filters.json '{profile: $p[0], filters: $f[0]}' > draft.json
wg.sh ranking preview --file draft.json
wg.sh seeking set --profile profile.json --filters filters.json --profile-base profile-shown.json --filters-base filters-shown.json
```

Over curl, add the revisions that `wg.sh api GET /profile` and `GET /filters` note on stderr to the draft as `"revisions": {"profile": …, "filters": …}`, save it as `both.json`, and send it with `wg.sh api PUT /seeking - < both.json`; a stale one refuses the whole write.

## Set up

Goal: Searches and a Profile that fit this person, with the effect and the cost shown before anything is saved.

Gather by conversation: city and categories, rent types, a loose price ceiling; the Profile (gender, age, whether Anmeldung is needed, move-in window, intended stay, diet, occupation, smoking, pets, languages, and a Place such as work with its postcode). `wg.sh preset example` is a fictional draft to start from; it applies nothing. Prefer to ask about what the human did not say and would change the crawl, such as rent types (`unlimited` suits a long stay; the default takes all three) and categories (a room, or flats too?), and to state the rest as assumptions to correct.

```sh
wg.sh ranking preview --file draft.json        # { "profile"?, "filters"? } draft: counts before / after
wg.sh crawl forecast --draft forecast.json     # saves nothing
wg.sh searches add --city Berlin --category flatshare-room --rent-type unlimited --price-ceiling 800
wg.sh seeking set --profile profile.json --filters filters.json   # both in one write
```

The city: wg-hunt knows the Source's id for Berlin, Hamburg, München, Köln, Frankfurt am Main, Stuttgart, Düsseldorf, Leipzig, Dresden, Hannover, Nürnberg, Bremen, Heidelberg, Freiburg im Breisgau, Münster, Aachen, Göttingen, Karlsruhe, Mannheim, Bonn and Darmstadt, in any case, with umlauts or written out (`muenchen`). Give the full name: `Frankfurt` or `Freiburg` alone is not recognised.

For any other city, ask the human for its city id before adding the Search: they search the city on wg-gesucht.de in their own browser, and the id is the first number after the city in the URL (`wg-zimmer-in-Hamburg.55.0.1.0.html` gives 55). Prefer asking over adding it without one, because such a Search reports `unknown-city` and is never polled. Don't look the id up yourself (Rule 1) or guess it: the id alone decides the city, so a wrong one quietly crawls somewhere else.

```sh
wg.sh searches add --city Potsdam --city-id <id> --category flatshare-room
```

The Search that comes back has `poll.problem`; `null` means it will be polled. A Search already showing `unknown-city` is fixed the same way: get the id, then `wg.sh searches edit <search> --city-id <id>`.

A forecast draft is the Searches as they would be after the change (`categories`, `recencyDays`, `enabled` and `pollInterval` of each are required), and the settings can be left out. Prefer leaving them out, because then the forecast is for the settings that will actually run. Prefer giving a new Search its `city` (and `cityId`, if it has one), and a stored Search its `id` (with `city` or `cityId` only when the draft changes them), because the forecast charges only Searches the Source can read, and a draft Search with neither is forecast as if it could be read:

```json
{
  "searches": [
    {
      "city": "Berlin",
      "categories": ["flatshare-room"],
      "recencyDays": 7,
      "enabled": true,
      "pollInterval": { "minMinutes": 30, "maxMinutes": 60 }
    }
  ]
}
```

Show the forecast (requests per day against the cap, `warnings`) and the preview, then apply on a yes. A Search whose row in the forecast's `searches` has a `problem` (`unknown-city`) or is disabled is not crawled and costs nothing; say so when one is there, because giving it its city id adds its requests to the day. When `halfBudget` is set, the caps are halved after a Cooldown until `halfBudget.until`, and the forecast (a draft's too) is worked from the halved `dailyCap`; say so, because the stretch and warnings ease once the full cap (`halfBudget.fullDailyCap`) is back. A new Search starts a Backfill at once; Troubleshoot shows how to follow it. The Anthropic key is the human's to enter (`wg-hunt secret set anthropic`); say so if `analysis status` shows `key: "absent"`, or `key: "refused"` (the saved key was refused: they replace it, or fix it at Anthropic and save the same key again, which tries it again).

## Curate

Goal: the human's judgement is recorded. Do it when asked, then say what changed and how to undo. A `#12` in their words is Offer id 12, as the dashboard shows it.

```sh
wg.sh offers mark <offer> --dismissed          # or --shortlisted, --contacted; --no-... takes it back
wg.sh offers list --shortlisted                # the shortlist, from every band, Hidden too
wg.sh offers mark <offer> --scam not           # override the verdict: scam | not | clear
wg.sh offers fact set <offer> anmeldung possible   # a hand-set fact wins over rules and model; `fact revert` undoes
wg.sh offers merge <offer> <other>             # same room: other folds into the first
wg.sh offers split <offer> <ad-id>             # that Ad ID is a different room
wg.sh offers release <offer>                   # a merge or split stops keeping the record; the verdict stays
```

Look at the Offer (`offers show`) first when a merge or split depends on its Ad IDs. Dismissed hides re-posts as well.

A merge keeps the first Offer's id. The other id then answers `offer-merged` (exit 3), for a merge you asked for and for one dedupe made. Marks on either side are kept (a scam mark wins over "not a scam"). A split-off Ad ID keeps the Offer's marks and band, so it is not new; fact corrections stay with the Offer it left. To undo a merge, split; to undo a split, merge.
A fact correction keeps the Ad ID it was made on through a merge, a split, a re-post or an edit (`madeOn` in the Offer's `corrections`). When its `wordsChanged` is true, the ad's words changed since: say so, and ask the human whether it still holds; setting it again makes it a correction of the words shown now.
Every mark, scam mark, fact correction, merge and split also keeps the Offer's record from the nightly prune. `retention` on the Offer says which (`keptBecause`) and when the record and the page snapshots fall due (`recordExpiresAt`, `snapshotExpiresAt`). To let a record go, clear what keeps it; for `pair-override`, `offers release` does that without undoing the merge or split. Releasing deletes data in time, so ask first.

## Troubleshoot

Goal: the human understands why crawling is quiet and what, if anything, is theirs to decide.

```sh
wg.sh crawl status
wg.sh crawl requests --limit 30      # newest first: kind, status, outcome, marker, path
wg.sh watch --count 3 --timeout 10   # a few live events; the first is the current status
```

On a quiet crawl a `watch-timeout` (exit 5) is normal; the exit codes are in [SKILL.md](SKILL.md). Without `--count`, `--timeout` is simply when `watch` stops, so it exits 0. Exit 1 with `stream-ended` means the server closed the stream, as it does when it restarts (the daily auto-update, for one), or answered without one; `stream-reset` means the connection broke. Either way, check `health` and run it again. Exit 1 with `session-ended` (and its `reason`) means the token the watch used stopped working, after a `token rotate` for one: the problem's `detail` says what to do.

An `events-missed` line means the watcher fell behind and the server dropped events in between (`missed` says how many); it is not counted towards `--count`. What it dropped is lost, so read the state again with `offers list` and `analysis status` rather than piecing it together from the events that follow.

An `analysis-status-changed` line carries what `analysis status` shows. It comes when the key, the spend cap's state or whether it pays for a run, the analysis settings or a re-analysis run change, any of which can change every Offer's analysis status at once, so the newest one is the current status, and an Offer read before it may be out of date.

Read the log for a run of `bot-check` outcomes (the `marker` says what the Source showed), 403/429 statuses, or `unexpected-page` / `handler-error` rows (both pause the crawl as a layout change; `paused.cause` says which). `pending` and `received` are still in flight. `interrupted` and `handler-interrupted` mean the server stopped mid-request: the first job is sent again, and for the second whatever is still needed is queued again at boot, so neither needs action. Then explain the state:

- **cooling-down**: after a Bot check; 2 h, 4 h, 8 h, then 24 h for each further one within 7 days. It cannot be cut short; the API refuses a Resume (exit 4). With an empty `holds` it carries on by itself at `nextRequest.at`; with `needs-resume` (or a Pause) in `holds` it waits for a person once it is over, so say that rather than "back at".
- **needs-resume**: the Cooldown is over, but a second Bot check within 24 h means a person decides when to continue. After a Resume comes one probe request, then half budget for 24 h (`halfBudgetUntil`): both caps are halved and poll intervals stretch to fit.
- **layout-changed**: read `paused.cause` first, because the two causes need different things. `unexpected-page`: a page was not recognised; the raw page is saved in the data folder (`paused.savedAs`, null when it could not be kept or has since been deleted by a wipe or the 30-day prune). The human should look before resuming, and the parser may need a fix. `handler-error`: wg-hunt failed while handling a page. The cause can be the disk, the database, or a page it cannot handle, so don't settle on one before looking: the server log has a `Handling <kind> <path> failed:` line with the error's class and code, and the newest `handler-error` row in `crawl requests` names the page (`storage show` has `freeBytes` for the disk). A Resume tries again and costs one request. If it pauses again with the same cause, prefer reading those over another Resume, because each one spends a request and pauses again. A `cause` of null is a pause from before wg-hunt recorded it: the newest `unexpected-page` or `handler-error` row in `crawl requests` says which it was.
- **disk-full**: under 1 GB is free where wg-hunt keeps its data; the human frees space, then resumes.
- **wiped**: the human deleted all Offer data. While the deletion still runs (`crawl status` has `actions.resumeRefusedBy` `wipe-running`) the API refuses a Resume with it (exit 4): wait, don't retry in a loop. Once it is done, a Resume starts a fresh backfill of every Search, which is a burst of requests; ask before resuming.
- **paused**, **outside-hours**: say who set it or what ends it.
- **Spend cap held** (`analysis status`, `spend.state` other than `ok`; crawling goes on, no model calls go out): `reached` ends at `spend.resetsAt` or with a higher cap (the human's call, `settings analysis set`); `waiting-for-in-flight` means batches in flight hold the rest (`spend.reservedUsd`) and it may clear by itself once they settle. `watch` shows `spend-cap-reached` and `spend-cap-cleared`. An `ok` state does not mean a re-analysis run would start; Re-analysis under Also asked for says what does.
- **One Search is quiet while the crawler runs**: `wg.sh searches list`. A `poll.problem` of `unknown-city` is why, and Set up has the fix. Its `sweep.status` is `idle` too; once the city is known it gets a Backfill by itself.
- **Offers of a Search look out of date**: `wg.sh searches show <search>`. Its `sweep` says whether a Backfill or the daily Sweep is running (`status` is `running`; `mode` says which, `backfill` at first and `daily` once the Backfill is done; `pagesRead` is the result pages read so far) or when the next starts (`status` is `scheduled`, at `startAt`, early in active hours); `lastFinishedAt` is when the last one ended. A Sweep that keeps failing on a page is given up and tried the next day, so a `startAt` tomorrow after a run of errors in `crawl requests` is that.
- **Old data is not going away, or the disk keeps filling**: `wg.sh storage show`. `prune.state` is `never`, `ok` or `failing`. With `ok`, `prune.lastSuccess` has when the nightly prune ran and what it `deleted`. With `failing`, every attempt since `failingSince` threw and `lastAttempt.error` is the kind: `disk-full` (the human frees space), `database-busy` (something else holds the database file, a backup tool for one), `database-error` or `unknown` (the server log has the error's name). wg-hunt tries again by itself at `nextAttemptAt`: 15 minutes after a failure, then twice as long each time, up to a day. No command prunes now, so say when the next attempt is instead of retrying something.
- **Offers kept older facts after an update, or stored pages never became Offers**: `wg.sh storage show`. `catchUp` is what the last start did to the Offers already stored. Its `state` is `running`, `finished`, `stopped` (a shutdown came first; the next start begins again) or `failed` (a phase broke off; the others still ran), and each of `phases` counts `done`, `skipped` and `failed`. `reparse.skipped` Offers keep the facts older rules read because their page is deleted, gone or unreadable; the same count comes back at every start, so say that instead of promising a fix. `failed` items threw and are tried again at the next start; the server log names the first one of each phase, with the error's code. A stored page that still throws a week after the first start that failed on it is given up and counted under `adoptPages.skipped`. A phase whose own `state` is `failed` broke off, most often because the database was locked or the disk full; it starts over at the next start. No command runs the catch-up: it runs once per start, in the background.

State the cause and the options. If Resume is the option, ask first (Rule 2). One Resume lifts every entry in `holds` at once, so name them all when you ask: a "yes, resume my pause" does not cover a `needs-resume` the human hasn't heard about.

## Also asked for

- **Re-analysis**: `analysis status` shows how many Offers are on an older analysis version (`olderVersion`) and the estimated cost; `analysis reanalyze` starts the run, `analysis run <id>` follows it. Before offering it, read `actions.startRunRefusedBy`: the problem the run would be refused with now, null when it would start. Prefer it over working it out from `key` and `spend`, because a run also needs room for each Offer's escalation and can be refused with `spend-cap-reached` while `spend.state` is `ok`. Name that blocker instead of the run; otherwise show the estimate, ask. A finished run's `counts.applied` is what was read again; `dropped` Offers changed or were merged while it ran and are not a failure. Offers count as older only once the model or effort changes (`settings analysis set`) or an update changes the analysis prompt, so before a model change there is no quote: estimate from `spend` and the price table in `settings analysis show`, call it an estimate, and ask before changing the setting.
- **One Offer read again**: `offers reanalyze <id>` is billed. Read `analysisStatus.next` on `offers show <id>` first: when it says `recheck`, `offers recheck <id>` comes first (Check in says why). A refusal with `analysis-in-batch` means a batch already holds the Offer's request and its result is on the way, and so does `in-batch` right after a `202`: the cap had room for the call only as a batch. Say so; don't retry it.
- **Delete all Offer data**: `storage show` for what would go, then `storage wipe --confirm "delete all Offer data"` only after the human has asked for it and seen what is deleted. It pauses crawling as `wiped`; Troubleshoot has what follows.
- **Settings**: `settings crawl show|set`, `settings analysis show|set`; Rule 3 applies, shown first with `crawl forecast --draft` for pacing.
- **Keys and token**: `secret list` (masked), `secret set <name>`, `token rotate`; only when asked for exactly that (Rule 4).

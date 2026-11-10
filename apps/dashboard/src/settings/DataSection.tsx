import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.js";
import { ask } from "../api/result.js";
import type { components } from "../api/schema.js";
import { useOfferCounts } from "../offer-counts.js";
import { Button } from "../ui/Button.js";
import { SettingRow, TextField } from "../ui/controls.js";
import { Disclosure, Notice } from "../ui/status.js";
import { formatBytes } from "./bytes.js";
import { Actions, Note, Problem, Section } from "./Section.js";
import { useStored } from "./stored.js";

type Storage = components["schemas"]["Storage"];
type Prune = Storage["prune"];
type CatchUp = Storage["catchUp"];
type Wiped = components["schemas"]["WipeResult"]["deleted"];

/** The server checks the same words. */
const WIPE_PHRASE = "delete all Offer data";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The prune runs on Berlin time, so its times are given in it. */
const berlinTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    timeZone: "Europe/Berlin",
    dateStyle: "medium",
    timeStyle: "short",
  });

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const CLEAN_UP_FAILED_BECAUSE: Record<
  NonNullable<NonNullable<Prune["lastAttempt"]>["error"]>,
  string
> = {
  "disk-full": "the disk is full",
  "database-busy": "something else was using the database",
  "database-error": "the database reported an error",
  unknown: "something unexpected went wrong",
};

/** Undefined when the clean-up's counts were not kept. */
function removedText(deleted: NonNullable<Prune["lastSuccess"]>["deleted"]): string | undefined {
  if (deleted === null) return undefined;
  const parts = [
    deleted.offers > 0 && plural(deleted.offers, "offer", "offers"),
    deleted.snapshots > 0 && plural(deleted.snapshots, "saved page", "saved pages"),
    deleted.unexpectedPages > 0 &&
      plural(deleted.unexpectedPages, "page that looked different", "pages that looked different"),
    deleted.requests > 0 && plural(deleted.requests, "logged request", "logged requests"),
  ].filter((part) => part !== false);
  return parts.length === 0 ? "Nothing was old enough to remove." : `It removed ${list(parts)}.`;
}

function LastCleanUp({ prune }: { prune: Prune }) {
  const last = prune.lastSuccess;
  const removed = last === null ? undefined : removedText(last.deleted);
  return (
    <dl className="adv-readout adv-readout-wide" aria-label="Clean-up">
      <div>
        <dt>Last clean-up</dt>
        {last === null ? (
          <dd>
            {prune.state === "failing" ? "It has not worked yet" : "Not yet"}
            {prune.state === "never" && (
              <span className="adv-cell-muted">. It runs within a minute of wg-hunt starting.</span>
            )}
          </dd>
        ) : (
          <dd>
            {berlinTime(last.startedAt)}
            {removed !== undefined && <span className="adv-cell-muted">. {removed}</span>}
          </dd>
        )}
      </div>
    </dl>
  );
}

function CleanUpFailing({ prune }: { prune: Prune }) {
  const error = prune.lastAttempt?.error ?? "unknown";
  return (
    <Notice
      tone="warn"
      title={`The nightly clean-up is failing: ${CLEAN_UP_FAILED_BECAUSE[error]}`}
      defaultOpen
    >
      It has failed
      {prune.failingSince !== null && ` since ${berlinTime(prune.failingSince)}`}. Until it works,
      old data may stay longer than it should.
      {error === "disk-full" && " Free some space where wg-hunt keeps its data."}
      {prune.nextAttemptAt !== null &&
        ` wg-hunt tries again around ${berlinTime(prune.nextAttemptAt)}.`}
    </Notice>
  );
}

type CatchUpRow = { label: string; text: string; more: string };

function catchUpRows(catchUp: CatchUp): CatchUpRow[] {
  if (catchUp.state === "running") {
    return [
      {
        label: "After starting",
        text: "Bringing saved offers up to date",
        more: "wg-hunt does this by itself each time it starts.",
      },
    ];
  }
  const { adoptPages, backfillProfiles, followCurrent, reparse } = catchUp.phases;
  const phases = [adoptPages, backfillProfiles, followCurrent, reparse];
  const failed = phases.reduce((sum, phase) => sum + phase.failed, 0);
  const rows: (CatchUpRow | false)[] = [
    reparse.skipped > 0 && {
      label: "Older facts",
      text: `${plural(reparse.skipped, "offer keeps", "offers keep")} facts an older version of wg-hunt read`,
      more: "Their page is gone or can't be read, so wg-hunt can't read it again.",
    },
    followCurrent.skipped > 0 && {
      label: "Earlier ad",
      text: `${plural(followCurrent.skipped, "offer still shows", "offers still show")} an earlier ad of the room`,
      more: "The page of its latest ad is gone or can't be read.",
    },
    backfillProfiles.skipped > 0 && {
      label: "Duplicates",
      text: `${plural(backfillProfiles.skipped, "ad is", "ads are")} checked for duplicates with less to go on`,
      more: "Their page is gone or can't be read.",
    },
    adoptPages.skipped > 0 && {
      label: "Saved pages",
      text: `${plural(adoptPages.skipped, "saved page", "saved pages")} did not become ${adoptPages.skipped === 1 ? "an offer" : "offers"}`,
      more: "They were gone or unreadable, or kept failing for a week.",
    },
    failed > 0 && {
      label: "Errors",
      text: `${plural(failed, "offer or page", "offers or pages")} could not be brought up to date`,
      more: `wg-hunt left ${failed === 1 ? "it as it was" : "them as they were"} and tries again the next time it starts.`,
    },
    phases.some((phase) => phase.state === "failed") && {
      label: "Stopped early",
      text: "Part of bringing saved offers up to date stopped on an error",
      more: "wg-hunt tries again the next time it starts.",
    },
  ];
  return rows.filter((row) => row !== false);
}

function CatchUpNotes({ catchUp }: { catchUp: CatchUp }) {
  const rows = catchUpRows(catchUp);
  if (rows.length === 0) return null;
  return (
    <dl className="adv-readout adv-readout-wide" aria-label="After the last start">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            {row.text}
            <span className="adv-cell-muted">. {row.more}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Readout({ storage }: { storage: Storage }) {
  const { offers } = storage;
  return (
    <dl className="adv-readout">
      <div>
        <dt>Database</dt>
        <dd>{formatBytes(storage.database.bytes)}</dd>
      </div>
      <div>
        <dt>Saved Offer pages</dt>
        <dd>
          {formatBytes(storage.snapshots.bytes)}
          <span className="adv-cell-muted">
            {" "}
            in {plural(storage.snapshots.files, "file", "files")}
          </span>
        </dd>
      </div>
      <div>
        <dt>Pages that looked different</dt>
        <dd>
          {formatBytes(storage.unexpectedPages.bytes)}
          <span className="adv-cell-muted">
            {" "}
            in {plural(storage.unexpectedPages.files, "file", "files")}
          </span>
        </dd>
      </div>
      <div>
        <dt>Request log</dt>
        <dd>{plural(storage.requestLog.rows, "request", "requests")}</dd>
      </div>
      <div>
        <dt>Free disk space</dt>
        <dd>{storage.freeBytes === null ? "Unknown" : formatBytes(storage.freeBytes)}</dd>
      </div>
      <div>
        <dt>Offers shown</dt>
        <dd>{offers.shown}</dd>
      </div>
      <div>
        <dt>Stale Offers</dt>
        <dd>{offers.stale}</dd>
      </div>
      <div>
        <dt>Untracked Offers</dt>
        <dd>{offers.untracked}</dd>
      </div>
      <div>
        <dt>Kept for your marks</dt>
        <dd>{offers.keptForMarks}</dd>
      </div>
    </dl>
  );
}

function Retention({ storage }: { storage: Storage }) {
  const r = storage.retention;
  return (
    <section className="adv-fold" aria-label="What is kept">
      <Disclosure title="What is kept, and for how long">
        <dl className="adv-readout adv-readout-wide" aria-label="Retention">
          <div>
            <dt>Offer records</dt>
            <dd>
              {r.recordDays} days after the Offer goes Stale or Untracked
              <span className="adv-cell-muted">
                . An offer you dismissed, shortlisted, contacted or marked as a scam, or that has a
                fact you corrected or a merge or split you made, keeps its record.
              </span>
            </dd>
          </div>
          <div>
            <dt>Saved Offer pages</dt>
            <dd>{r.snapshotDays} days after the Offer goes Stale or Untracked, marked or not</dd>
          </div>
          <div>
            <dt>Pages that looked different</dt>
            <dd>{r.unexpectedPageDays} days</dd>
          </div>
          <div>
            <dt>Request log</dt>
            <dd>{r.requestLogDays} days</dd>
          </div>
          <div>
            <dt>Nightly clean-up</dt>
            <dd>
              Around {r.pruneAt}
              <span className="adv-cell-muted">
                . If it fails, wg-hunt tries again after 15 minutes, then waits twice as long each
                time, up to a day.
              </span>
            </dd>
          </div>
          <div>
            <dt>Low disk</dt>
            <dd>
              Checking stops when less than {formatBytes(r.lowDiskBytes)} is free, and waits for you
              to switch Keep hunting back on
            </dd>
          </div>
        </dl>
      </Disclosure>
    </section>
  );
}

type Step =
  | { step: "idle" }
  | { step: "confirming" }
  | { step: "deleting" }
  | { step: "done"; deleted: Wiped };

function DeleteAll({
  api,
  wipedAt,
  onDone,
  onUnanswered,
}: {
  api: ApiClient;
  wipedAt: string | undefined;
  onDone: (storage: Storage) => void;
  onUnanswered: () => Promise<Storage | undefined>;
}) {
  const [state, setState] = useState<Step>({ step: "idle" });
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string>();

  function close() {
    setState({ step: "idle" });
    setTyped("");
    setProblem(undefined);
  }

  async function wipe(event: FormEvent) {
    event.preventDefault();
    if (typed !== WIPE_PHRASE) return;
    setState({ step: "deleting" });
    setProblem(undefined);
    const wiped = await ask(() => api.POST("/storage/wipe", { body: { confirm: typed } }));
    if (!wiped.ok) return unanswered(wiped.message);
    setTyped("");
    setState({ step: "done", deleted: wiped.data.deleted });
    onDone(wiped.data.storage);
  }

  // A failed request may still have started the wipe (a proxy timeout is a status, not a throw):
  // the storage says whether it did.
  async function unanswered(message: string) {
    const before = wipedAt;
    const now = await onUnanswered();
    if (now?.wipe.running) {
      close();
      return;
    }
    const last = now?.wipe.last;
    if (last && last.at !== before) {
      setTyped("");
      setState({ step: "done", deleted: last.deleted });
      return;
    }
    setProblem(message);
    setState({ step: "confirming" });
  }

  if (state.step === "done") {
    const { deleted } = state;
    return (
      <div className="adv-form">
        <Notice tone="info">
          Deleted {plural(deleted.offers, "offer", "offers")} and{" "}
          {plural(deleted.snapshots, "saved page", "saved pages")}. Checking is paused: switch Keep
          hunting back on, and wg-hunt reads every Search from the start.
        </Notice>
        <Actions>
          <Button size="sm" variant="secondary" onClick={close}>
            Done
          </Button>
        </Actions>
      </div>
    );
  }

  return (
    <div className="adv-form">
      <SettingRow
        title="Start over"
        description="Deletes every offer, its history and your marks. Profile, Filters, Searches and keys stay."
        control={
          state.step === "idle" && (
            <Button size="sm" variant="secondary" onClick={() => setState({ step: "confirming" })}>
              Delete all Offer data
            </Button>
          )
        }
      />
      {state.step !== "idle" && (
        <form className="adv-form" onSubmit={wipe}>
          <Notice tone="alarm" role="status">
            This can't be undone. It deletes every offer, its history, your marks and corrections,
            saved pages and the request log, and pauses checking.
          </Notice>
          <TextField
            label={`Type “${WIPE_PHRASE}” to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={state.step === "deleting"}
          />
          <Actions>
            <Button
              type="submit"
              size="sm"
              variant="danger"
              disabled={typed !== WIPE_PHRASE || state.step === "deleting"}
            >
              Delete everything
            </Button>
            <Button size="sm" variant="ghost" onClick={close} disabled={state.step === "deleting"}>
              Cancel
            </Button>
          </Actions>
        </form>
      )}
      {problem && <Notice tone="alarm">{problem}</Notice>}
    </div>
  );
}

export const WIPE_POLL_MS = 3000;

export function DataSection({ api }: { api: ApiClient }) {
  const load = useCallback(() => ask(() => api.GET("/storage")), [api]);
  // The readout after a wipe comes with its answer, so the section is not loaded again.
  const { state, value: storage, replace, retry } = useStored(load);
  // The nav rail's counts are of Offers that no longer exist.
  const { refresh: refreshCounts } = useOfferCounts();
  const wiping = storage?.wipe.running != null;
  const wipedAt = storage?.wipe.last?.at;
  const countedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (storage === undefined) return;
    const at = wipedAt ?? null;
    if (countedFor.current !== undefined && countedFor.current !== at) refreshCounts();
    countedFor.current = at;
  }, [storage, wipedAt, refreshCounts]);
  const busy = wiping || storage?.catchUp.state === "running";

  // A wipe started from the CLI or another tab ends without this page hearing of it, and so does
  // the catch-up after a start.
  useEffect(() => {
    if (!busy) return;
    let stopped = false;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void load()
        .then((fresh) => {
          if (!stopped && fresh.ok) replace(fresh.data);
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    }, WIPE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [busy, load, replace]);

  return (
    <Section title="Stored data">
      {state.status === "loading" && <Note role="status">Loading…</Note>}
      {state.status === "failed" && <Problem message={state.message} onRetry={retry} />}
      {storage && (
        <>
          {wiping && (
            <Notice tone="info" title="Deleting all offer data">
              wg-hunt waits for the page it is reading, then deletes. The numbers below are from
              before. Checking stays paused afterwards until you switch Keep hunting back on.
            </Notice>
          )}
          {storage.prune.state === "failing" && <CleanUpFailing prune={storage.prune} />}
          <Readout storage={storage} />
          <LastCleanUp prune={storage.prune} />
          <CatchUpNotes catchUp={storage.catchUp} />
          <Retention storage={storage} />
          <DeleteAll
            api={api}
            wipedAt={wipedAt}
            onDone={replace}
            onUnanswered={async () => {
              const fresh = await load().catch(() => undefined);
              if (!fresh?.ok) return undefined;
              replace(fresh.data);
              return fresh.data;
            }}
          />
        </>
      )}
    </Section>
  );
}

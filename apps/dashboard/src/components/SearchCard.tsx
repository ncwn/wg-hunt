import { useEffect, useId, useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { Result } from "../api/result.js";
import { useCheckNow } from "../check-now.js";
import { type DraftSearch, draftList } from "../forecast.js";
import { useMutation } from "../mutation.js";
import {
  type CrawlNowAnswer,
  describeSearch,
  describeSweep,
  formatWhen,
  type Search,
  type SearchChanges,
  sourceLabel,
} from "../searches.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Confirm.js";
import { Toggle } from "../ui/controls.js";
import { Notice } from "../ui/status.js";
import { DraftForecast } from "./DraftForecast.js";
import { SearchForm } from "./SearchForm.js";

type Props = {
  search: Search;
  forecast: { api: ApiClient; all: Search[] };
  onUpdate: (id: number, changes: SearchChanges) => Promise<Result<unknown>>;
  onDelete: (id: number) => Promise<Result<unknown>>;
  onCrawlNow: (id: number) => Promise<Result<CrawlNowAnswer>>;
  onOpenChange?: (open: boolean) => void;
};

export function SearchCard({
  search,
  forecast,
  onUpdate,
  onDelete,
  onCrawlNow,
  onOpenChange,
}: Props) {
  const [mode, setMode] = useState<"view" | "edit" | "confirmDelete">("view");
  // A message is about the Search as it stood and the step the card was on: opening the form or
  // the delete question, or a change to the Search, starts afresh.
  const context = `${search.id}:${search.updatedAt}:${search.enabled}:${search.poll.problem}:${mode}`;
  const changing = useMutation(context);
  const checking = useCheckNow(search, context, onCrawlNow);
  const busy = changing.busy || checking.busy;
  const [draft, setDraft] = useState<DraftSearch>();
  const titleId = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the mode decides what is told
  useEffect(() => {
    onOpenChange?.(mode !== "view");
    return () => onOpenChange?.(false);
  }, [mode]);

  function change(action: () => Promise<Result<unknown>>) {
    checking.reset();
    void changing.run(action);
  }

  function checkNow() {
    changing.reset();
    void checking.run();
  }

  const { pollInterval, poll } = search;
  const canCrawl = search.enabled && poll.problem === null;
  const meta = [
    sourceLabel(search.source),
    `Every ${pollInterval.minMinutes}–${pollInterval.maxMinutes} min`,
    search.enabled && poll.nextAt ? `Next check ${formatWhen(poll.nextAt)}` : undefined,
    search.enabled ? describeSweep(search.sweep) : undefined,
  ].filter(Boolean);

  return (
    <article className={`wh-card sc${search.enabled ? "" : " sc-off"}`} aria-labelledby={titleId}>
      <header className="sc-head">
        <div className="sc-text">
          <h2 id={titleId} className="sc-title">
            {describeSearch(search)}
          </h2>
          <p className="sc-meta">
            {meta.map((part) => (
              <span key={part}>{part}</span>
            ))}
          </p>
        </div>
        <div className="sc-switch">
          <span aria-hidden="true">{search.enabled ? "On" : "Off"}</span>
          <Toggle
            label={`Search on: ${search.city}`}
            checked={search.enabled}
            disabled={busy}
            onChange={() => change(() => onUpdate(search.id, { enabled: !search.enabled }))}
          />
        </div>
      </header>

      {poll.problem === "unknown-city" && mode !== "edit" && (
        <Notice tone="warn">
          This search isn't checked: add the city number for {search.city} in Edit.
        </Notice>
      )}

      {mode === "edit" && (
        <div className="sc-edit">
          <SearchForm
            search={search}
            onCancel={() => setMode("view")}
            onDraft={setDraft}
            onSubmit={async (fields) => {
              const result = await onUpdate(search.id, fields);
              if (result.ok) setMode("view");
              return result;
            }}
          />
          <DraftForecast
            compact
            api={forecast.api}
            draft={draft && draftList(forecast.all, draft, search.id)}
          />
        </div>
      )}

      {mode === "confirmDelete" && (
        <Confirm
          danger
          question={`Delete the search for ${search.city}?`}
          confirmLabel="Delete search"
          cancelLabel="Keep"
          busy={busy}
          problem={changing.state.status === "failed" && changing.state.message}
          onConfirm={() => change(() => onDelete(search.id))}
          onCancel={() => setMode("view")}
        >
          Rooms only this search found stop being tracked and are hidden.
        </Confirm>
      )}

      {mode === "view" && (
        <div className="sc-actions">
          <Button
            size="sm"
            icon="refresh"
            aria-label={`Check now: ${search.city}`}
            disabled={busy || !canCrawl}
            onClick={checkNow}
          >
            Check now
          </Button>
          <Button size="sm" aria-label={`Edit ${search.city}`} onClick={() => setMode("edit")}>
            Edit
          </Button>
          <Button
            size="sm"
            aria-label={`Delete ${search.city}`}
            onClick={() => setMode("confirmDelete")}
          >
            Delete
          </Button>
        </div>
      )}

      {checking.state.status === "done" && <Notice tone="info">{checking.state.message}</Notice>}
      {checking.state.status === "failed" && <Notice tone="alarm">{checking.state.message}</Notice>}
      {/* A failed delete is told in its question, which covers the card. */}
      {changing.state.status === "failed" && mode !== "confirmDelete" && (
        <Notice tone="alarm">{changing.state.message}</Notice>
      )}
    </article>
  );
}

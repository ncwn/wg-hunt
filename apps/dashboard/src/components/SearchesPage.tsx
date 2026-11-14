import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ApiClient } from "../api/client.js";
import type { EventStream } from "../events.js";
import { type DraftSearch, draftList } from "../forecast.js";
import { useSearches } from "../searches.js";
import { Button } from "../ui/Button.js";
import { Notice } from "../ui/status.js";
import { DraftForecast } from "./DraftForecast.js";
import { SearchCard } from "./SearchCard.js";
import { SearchForm, type SearchStart } from "./SearchForm.js";
import { TopBar } from "./TopBar.js";

function count(items: { enabled: boolean }[]) {
  const on = items.filter((search) => search.enabled).length;
  const all = `${items.length} ${items.length === 1 ? "search" : "searches"}`;
  return on === items.length ? all : `${all} · ${on} on`;
}

export function SearchesPage({ api, events }: { api: ApiClient; events: EventStream }) {
  const { state, reload, create, update, remove, crawlNow } = useSearches(api, events);
  const location = useLocation();
  const navigate = useNavigate();
  const suggested = (location.state as { draftSearch?: SearchStart } | null)?.draftSearch;
  const [adding, setAdding] = useState(suggested !== undefined);
  // Once the form closes, the suggestion is spent: Back, Forward or a reload must not offer it
  // again and so make the same Search twice.
  const closeForm = () => {
    setAdding(false);
    if (suggested !== undefined) navigate(location.pathname, { replace: true, state: null });
  };
  const [draft, setDraft] = useState<DraftSearch>();
  const [openCards, setOpenCards] = useState<ReadonlySet<number>>(new Set());
  const cardOpen = useCallback(
    (id: number, open: boolean) =>
      setOpenCards((current) => {
        if (current.has(id) === open) return current;
        const next = new Set(current);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );

  return (
    <div className="searches">
      <TopBar
        title="Searches"
        subtitle={
          state.status === "ready" && state.items.length > 0 ? count(state.items) : undefined
        }
      >
        {state.status === "ready" && !adding && (
          <Button
            variant={openCards.size === 0 ? "primary" : "secondary"}
            icon="plus"
            onClick={() => setAdding(true)}
          >
            Add a search
          </Button>
        )}
      </TopBar>

      {state.status === "loading" && (
        <p role="status" className="searches-caption">
          Loading your searches…
        </p>
      )}

      {state.status === "failed" && (
        <div className="searches-problem">
          <Notice tone="alarm" title={`Couldn't load your searches: ${state.problem.message}`} />
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {state.status === "ready" && (
        <div className="searches-list">
          {adding && (
            <section className="wh-card sc" aria-labelledby="new-search-title">
              <h2 id="new-search-title" className="sc-title">
                New search
              </h2>
              <SearchForm
                {...(suggested && { start: suggested })}
                onCancel={closeForm}
                onDraft={setDraft}
                onSubmit={async (fields) => {
                  const result = await create(fields);
                  if (result.ok) closeForm();
                  return result;
                }}
              />
              <DraftForecast compact api={api} draft={draft && draftList(state.items, draft)} />
            </section>
          )}
          {state.items.length === 0 && !adding && (
            <div className="wh-card searches-empty">
              <p className="searches-empty-title">No searches yet</p>
              <p className="searches-caption">Add one and wg-hunt starts looking for rooms.</p>
            </div>
          )}
          {state.items.map((search) => (
            <SearchCard
              key={search.id}
              search={search}
              forecast={{ api, all: state.items }}
              onUpdate={update}
              onDelete={remove}
              onCrawlNow={crawlNow}
              onOpenChange={(open) => cardOpen(search.id, open)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

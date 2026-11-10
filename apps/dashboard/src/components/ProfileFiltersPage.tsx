import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { ApiClient } from "../api/client.js";
import { type HeldDraft, useSeekingDraft } from "../draft.js";
import type { EventStream } from "../events.js";
import { useMutation } from "../mutation.js";
import { rebase } from "../rebase.js";
import { CHANGED_ELSEWHERE, changedElsewhereUnread } from "../revision.js";
import { describeSearch, type Search } from "../searches.js";
import {
  type ExamplePreset,
  type Filters,
  loadExample,
  loadSeeking,
  type Place,
  type Saved,
  type SeekerProfile,
  type Seeking,
  sameSeeking,
  saveSeeking,
  useBandPreview,
} from "../seeking.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Confirm.js";
import { SidePanel, useLeaving } from "../ui/SidePanel.js";
import { Notice } from "../ui/status.js";
import { DraftPreview } from "./DraftPreview.js";
import { FiltersEditor } from "./FiltersEditor.js";
import { ProfileEditor } from "./ProfileEditor.js";
import { TopBar } from "./TopBar.js";

type Loaded =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; saved: Saved };

const sameRevisions = (a: Saved, b: Saved) =>
  a.revisions.profile === b.revisions.profile && a.revisions.filters === b.revisions.filters;

function onto(held: HeldDraft | null, saved: Saved, from = held?.base.seeking): HeldDraft | null {
  if (!held || !from) return null;
  const draft = rebase(from, held.draft, saved.seeking);
  return sameSeeking(draft, saved.seeking) ? null : { base: saved, draft };
}

function followPlaces(before: Place[], after: Place[], filters: Filters): Filters {
  const named = filters.distance.place;
  if (named === null) return filters;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const target = (place: string | null): Filters => ({
    ...filters,
    distance: { ...filters.distance, place },
  });
  if (after.length < before.length) {
    return after.some((place) => same(place.name, named)) ? filters : target(null);
  }
  const renamed = after.find(
    (place, index) => before[index] && same(before[index].name, named) && !same(place.name, named),
  );
  return renamed && renamed.name.trim() !== "" ? target(renamed.name) : filters;
}

export function ProfileFiltersPage({ api, events }: { api: ApiClient; events?: EventStream }) {
  const { held, setHeld } = useSeekingDraft();
  const draft = held?.draft ?? null;
  const latestHeld = useRef(held);
  latestHeld.current = held;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [presetSearch, setPresetSearch] = useState<ExamplePreset["search"]>();
  const [replacing, setReplacing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const example = useMutation();
  const navigate = useNavigate();

  /** Resolves to why it couldn't; a quiet read that fails leaves the page as it is. */
  const load = useCallback(
    async (quiet = false): Promise<string | undefined> => {
      if (!quiet) setLoaded({ status: "loading" });
      const result = await loadSeeking(api);
      if (!result.ok) {
        if (!quiet) setLoaded({ status: "failed", message: result.message });
        return result.message;
      }
      const fresh = result.data;
      // Decided from the draft as last rendered, not inside the updater: React may run that later.
      const before = latestHeld.current;
      const moved = before !== null && !sameRevisions(before.base, fresh);
      setHeld((current) =>
        !current || sameRevisions(current.base, fresh) ? current : onto(current, fresh),
      );
      setLoaded({ status: "ready", saved: fresh });
      if (moved && !quiet) setNotice(CHANGED_ELSEWHERE);
      return undefined;
    },
    [api, setHeld],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const retry = () => void load();

  const saved = loaded.status === "ready" ? loaded.saved : undefined;
  const { state: preview, retry: retryPreview } = useBandPreview(api, draft, events);
  const problem =
    saveError ??
    (example.state.status === "failed"
      ? `Couldn't load the example: ${example.state.message}`
      : undefined);
  const panel = useLeaving(draft ? { preview, saving, saveError: problem } : undefined);

  if (loaded.status === "loading")
    return (
      <PageHead>
        <p role="status" className="pf-caption">
          Loading your profile…
        </p>
      </PageHead>
    );
  if (loaded.status === "failed" || !saved)
    return (
      <PageHead>
        <div className="pf-problem">
          <Notice
            tone="alarm"
            title={`Couldn't load your profile: ${loaded.status === "failed" ? loaded.message : ""}`}
          />
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      </PageHead>
    );

  const current = draft ?? saved.seeking;
  const edit = (next: Seeking) => {
    setNotice(undefined);
    setSaveError(undefined);
    if (example.state.status === "failed") example.reset();
    setHeld(sameSeeking(next, saved.seeking) ? null : { base: saved, draft: next });
  };
  const editProfile = (profile: SeekerProfile) => edit({ ...current, profile });
  const editPlaces = (places: Place[]) =>
    edit({
      profile: { ...current.profile, places },
      filters: followPlaces(current.profile.places, places, current.filters),
    });

  function askForPreset() {
    if (draft) setReplacing(true);
    else loadPreset();
  }

  /** Focus goes back to the button that asked, not to the page. */
  function stopAsking() {
    if (!replacing) return;
    setReplacing(false);
    document.getElementById("load-example")?.focus();
  }

  function loadPreset() {
    stopAsking();
    setSaveError(undefined);
    void example.run(async () => {
      const result = await loadExample(api);
      if (!result.ok) return result;
      const { profile, filters, search } = result.data;
      edit({ profile, filters });
      setPresetSearch(search);
      setNotice("Example loaded as a draft. Nothing is saved until you press Save.");
      return { ok: true, data: undefined };
    });
  }

  async function save() {
    if (!held) return;
    const sent = held;
    setSaving(true);
    setSaveError(undefined);
    setNotice(undefined);
    const result = await saveSeeking(api, sent.draft, sent.base);
    if (result.status === "saved") {
      // Anything typed while the save was on its way stays a draft over what was saved.
      setHeld((latest) => onto(latest, result.saved, sent.draft));
      setLoaded({ status: "ready", saved: result.saved });
      setNotice("Saved. Your Offers are already ranked by the new answers.");
    } else if (result.status === "stale") {
      const unread = await load(true);
      setSaveError(unread === undefined ? CHANGED_ELSEWHERE : changedElsewhereUnread(unread));
    } else {
      setSaveError(`Nothing was saved: ${result.problem.message}`);
    }
    setSaving(false);
  }

  function discard() {
    setDiscarding(false);
    setHeld(null);
    setSaveError(undefined);
    if (example.state.status === "failed") example.reset();
    setNotice(undefined);
    setPresetSearch(undefined);
  }

  return (
    <PageHead
      action={
        <Button id="load-example" onClick={askForPreset} disabled={example.busy}>
          Load example
        </Button>
      }
    >
      {replacing && (
        <Confirm
          question="Replace your unsaved changes with the example?"
          confirmLabel="Replace"
          onConfirm={loadPreset}
          onCancel={stopAsking}
        >
          What you changed is thrown away. Nothing is saved until you press Save.
        </Confirm>
      )}
      {/* With a draft the preview panel says it; without one there is no panel to say it in. */}
      {!draft && problem && <Notice tone="alarm">{problem}</Notice>}
      {/* One message in this spot: with the example's Search, the news heads it. */}
      {presetSearch ? (
        <div className="pf-suggest">
          <Notice tone="info" title={notice ?? "From the example"}>
            {/* Only the fields a description reads; the example's Search isn't saved yet. */}
            It also suggests a search: {describeSearch(presetSearch as Search)}.
          </Notice>
          <Button
            size="sm"
            onClick={() => navigate("/searches", { state: { draftSearch: presetSearch } })}
          >
            Review it in Searches
          </Button>
        </div>
      ) : (
        notice && <Notice tone="info">{notice}</Notice>
      )}
      <div className="pf-cards">
        <section
          className="wh-card pf-card"
          data-draft={draft ? "true" : undefined}
          aria-labelledby="profile-title"
        >
          <h2 id="profile-title" className="pf-title">
            About you
          </h2>
          <ProfileEditor profile={current.profile} onChange={editProfile} onPlaces={editPlaces} />
        </section>
        <section
          className="wh-card pf-card"
          data-draft={draft ? "true" : undefined}
          aria-labelledby="filters-title"
        >
          <h2 id="filters-title" className="pf-title">
            What the room should be
          </h2>
          <FiltersEditor
            filters={current.filters}
            places={current.profile.places}
            onChange={(filters) => edit({ ...current, filters })}
          />
        </section>
      </div>
      {panel.shown && (
        <SidePanel label="Draft preview" className="pf-panel" closing={panel.closing}>
          <DraftPreview
            preview={panel.shown.preview}
            saving={panel.shown.saving}
            onSave={save}
            onDiscard={() => setDiscarding(true)}
            onRetry={retryPreview}
            saveError={panel.shown.saveError}
          />
        </SidePanel>
      )}
      {discarding && (
        <Confirm
          question="Discard your unsaved changes?"
          confirmLabel="Discard"
          danger
          onConfirm={discard}
          onCancel={() => setDiscarding(false)}
        >
          Your Profile and Filters go back to what was last saved.
        </Confirm>
      )}
    </PageHead>
  );
}

function PageHead({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="pf">
      <TopBar title="Profile & Filters">{action}</TopBar>
      {children}
    </div>
  );
}

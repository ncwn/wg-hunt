import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { Result } from "../api/result.js";
import type { components } from "../api/schema.js";
import { useSettingsDraft } from "../draft.js";
import { useMutation } from "../mutation.js";
import {
  type CrawlConstants,
  type CrawlSettings,
  check,
  type FieldErrors,
  type FieldKey,
  isDraft,
  type PacingForm,
  sortServerErrors,
  toForm,
} from "../pacing.js";
import { rebase } from "../rebase.js";
import {
  CHANGED_ELSEWHERE,
  changedElsewhereUnread,
  type Doc,
  ifMatch,
  readDoc,
} from "../revision.js";
import { useLoaded } from "../settings/request.js";
import { Actions, Problem } from "../settings/Section.js";
import { Button } from "../ui/Button.js";
import { SettingRow, TextField, TimeField, Toggle } from "../ui/controls.js";
import { Disclosure, Notice } from "../ui/status.js";
import { DraftForecast } from "./DraftForecast.js";

type Loaded = CrawlSettings & { constants: CrawlConstants };
function Constants({ constants }: { constants: CrawlConstants }) {
  const ladder = constants.cooldownLadderHours;
  const last = ladder[ladder.length - 1];
  const steps = ladder
    .slice(0, -1)
    .map((h) => `${h} h`)
    .join(", ");
  return (
    <section className="adv-tile" aria-labelledby="constants-title">
      <h4 id="constants-title" className="adv-tile-title">
        Fixed limits
      </h4>
      <ul className="adv-list">
        <li>
          {constants.maxInFlight === 1 ? "One request" : `${constants.maxInFlight} requests`} at a
          time
        </li>
        <li>At least {constants.gapFloorSeconds} s between requests</li>
        <li>At most {constants.dailyCeiling} requests a day</li>
        <li>
          {constants.rotation === "none"
            ? "The same address, browser and cookies every time"
            : `Rotation: ${constants.rotation}`}
        </li>
        <li>{`${constants.forbidden.charAt(0).toUpperCase()}${constants.forbidden.slice(1)}`}</li>
        <li>
          When wg-gesucht asks whether you're a person, a break of {steps}, then {last} h for each
          further time within 7 days. Twice within 24 h waits for you.
        </li>
        <li>Half pace for {constants.halfBudgetHours} h after a break</li>
      </ul>
    </section>
  );
}

type Props = {
  api: ApiClient;
  onSaved: () => void;
  refresh: unknown;
  outside?: unknown;
};

const getCrawl = (api: ApiClient) =>
  api.GET("/settings/crawl") as Promise<{ data?: Loaded; error?: unknown; response: Response }>;

export function PacingEditor({ api, onSaved, refresh, outside }: Props) {
  const load = useCallback(() => readDoc(() => getCrawl(api)), [api]);
  const { state, retry } = useLoaded(load);
  const kept = useSettingsDraft().pacing !== null;

  return (
    <section className="adv-fold" aria-label="Pacing">
      <Disclosure title="Pacing" defaultOpen={kept}>
        {state.status === "loading" ? (
          <p role="status" className="adv-note">
            Loading the pacing…
          </p>
        ) : state.status === "failed" ? (
          <Problem message={`Couldn't load the pacing: ${state.message}`} onRetry={retry} />
        ) : (
          <Editor
            api={api}
            initial={state.data}
            onSaved={onSaved}
            refresh={refresh}
            outside={outside}
          />
        )}
      </Disclosure>
    </section>
  );
}

export type HeldPacing = { stored: Loaded; revision: string | undefined; form: PacingForm };

function Editor({ api, initial, onSaved, refresh, outside }: Props & { initial: Doc<Loaded> }) {
  const kept = useSettingsDraft();
  const [held, setHeld] = useState<HeldPacing>(() => ({
    stored: initial.data,
    revision: initial.revision,
    form: kept.pacing
      ? rebase(toForm(kept.pacing.stored), kept.pacing.form, toForm(initial.data))
      : toForm(initial.data),
  }));
  const { stored, form } = held;
  const setForm = (update: (current: PacingForm) => PacingForm) =>
    setHeld((now) => ({ ...now, form: update(now.form) }));
  // Reads and saves are numbered as they start. A copy that comes back after one started later was
  // already adopted is older than what is held, so it is dropped: otherwise a slow re-read would
  // undo the editor's own save and the next save would be refused as "changed elsewhere".
  const started = useRef(0);
  const adopted = useRef(0);
  const start = useCallback(() => {
    started.current += 1;
    return started.current;
  }, []);
  const adopt = useCallback((ticket: number, doc: Doc<Loaded>, from?: PacingForm) => {
    if (ticket < adopted.current) return;
    adopted.current = ticket;
    setHeld((now) => ({
      stored: doc.data,
      revision: doc.revision,
      form: rebase(from ?? toForm(now.stored), now.form, toForm(doc.data)),
    }));
  }, []);

  const seen = useRef(outside);
  useEffect(() => {
    if (Object.is(seen.current, outside)) return;
    seen.current = outside;
    const ticket = start();
    void readDoc(() => getCrawl(api)).then((fresh) => {
      if (fresh.ok) adopt(ticket, fresh.data);
    });
  }, [api, outside, adopt, start]);
  // A refusal goes once the settings are saved from outside this editor. Not on the editor's own
  // re-read after a stale save: that lands with the refusal it explains, in the same render.
  const saving = useMutation(outside);
  const { busy } = saving;
  const refusedFields = useRef<FieldErrors>({});

  const draft = isDraft(toForm(stored), form);
  const { setPacing } = kept;
  useEffect(() => setPacing(draft ? held : null), [held, draft, setPacing]);
  const checked = check(form, stored.constants);
  const errors: FieldErrors = {
    ...(saving.state.status === "failed" ? refusedFields.current : {}),
    ...("errors" in checked ? checked.errors : {}),
  };
  const valid = "settings" in checked;
  const refusal = saving.state.status === "failed" ? saving.state.message : "";

  const set = <K extends FieldKey>(key: K, value: PacingForm[K]) => {
    // A save on its way keeps its pending state, or Save would come back on and send it twice.
    if (saving.state.status === "failed") saving.reset();
    setForm((current) => ({ ...current, [key]: value }));
  };

  function save() {
    if (!("settings" in checked)) return;
    const sent = form;
    const body = checked.settings;
    const revision = held.revision;
    void saving.run(async (): Promise<Result<undefined>> => {
      refusedFields.current = {};
      const ticket = start();
      const written = await readDoc(
        () =>
          api.PUT("/settings/crawl", { body, params: ifMatch(revision) }) as ReturnType<
            typeof getCrawl
          >,
      );
      if (written.ok) {
        // What was sent is stored; anything typed while it was on its way stays a draft.
        const doc = written.data;
        adopt(ticket, doc, sent);
        // The seeker may have left Settings by now, so the kept copy learns of the save as well:
        // otherwise it would keep the dot, and bring the saved edit back over a later change.
        setPacing((kept) => {
          if (!kept) return null;
          const next = {
            stored: doc.data,
            revision: doc.revision,
            form: rebase(sent, kept.form, toForm(doc.data)),
          };
          return isDraft(toForm(next.stored), next.form) ? next : null;
        });
        onSaved();
        return { ok: true, data: undefined };
      }
      if (written.status === 412) {
        const again = start();
        const fresh = await readDoc(() => getCrawl(api));
        if (!fresh.ok) return { ok: false, message: changedElsewhereUnread(fresh.message) };
        adopt(again, fresh.data);
        return { ok: false, message: CHANGED_ELSEWHERE };
      }
      const fieldErrors = written.errors ?? [];
      const sorted = sortServerErrors(fieldErrors);
      if (fieldErrors.length === 0) sorted.general.push(written.message);
      refusedFields.current = sorted.byField;
      return { ok: false, message: sorted.general.join(" ") };
    });
  }

  const input = (key: FieldKey, label: string, suffix?: string) => (
    <TextField
      className="wh-number"
      label={label}
      suffix={suffix}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={form[key] as string}
      error={errors[key]}
      onChange={(event) => set(key, event.target.value as never)}
    />
  );
  /** Berlin time, in half hours. */
  const time = (key: "activeStart" | "activeEnd", label: string) => (
    <TimeField
      label={label}
      value={form[key]}
      error={errors[key]}
      onChange={(next) => set(key, next)}
    />
  );

  const settings: components["schemas"]["CrawlSettings"] | undefined =
    draft && "settings" in checked ? checked.settings : undefined;

  return (
    <div className="adv-pacing">
      <form
        className="adv-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <fieldset className="adv-group">
          <legend className="adv-label">Gap between requests</legend>
          <div className="adv-fields">
            {input("gapMinSeconds", "Shortest gap", "s")}
            {input("gapMaxSeconds", "Longest gap", "s")}
          </div>
        </fieldset>
        <fieldset className="adv-group">
          <legend className="adv-label">Sessions and breaks</legend>
          <div className="adv-fields">
            {input("sessionSize", "Requests per session")}
            {input("breakMinMinutes", "Shortest break", "min")}
            {input("breakMaxMinutes", "Longest break", "min")}
          </div>
        </fieldset>
        <fieldset className="adv-group">
          <legend className="adv-label">Limits</legend>
          <div className="adv-fields">
            {input("hourlyCap", "Most requests an hour")}
            {input("dailyCap", "Most requests a day")}
          </div>
        </fieldset>
        <fieldset className="adv-group">
          <legend className="adv-label">When to check</legend>
          <div className="adv-fields">
            {time("activeStart", "Checks from")}
            {time("activeEnd", "Checks until")}
          </div>
        </fieldset>
        <fieldset className="adv-group">
          <legend className="adv-label">Rechecks</legend>
          <SettingRow
            title="Recheck bumped offers"
            description="Reads a bumped offer again"
            control={
              <Toggle
                label="Automatic rechecks"
                checked={form.recheckEnabled}
                onChange={(on) => set("recheckEnabled", on)}
              />
            }
          />
          <div className="adv-fields">
            {input("maxPageAgeHours", "Recheck pages older than", "h")}
          </div>
        </fieldset>

        {refusal && <Notice tone="alarm">{refusal}</Notice>}

        {draft && (
          <Actions>
            <Button type="submit" variant="primary" size="sm" disabled={busy || !valid}>
              Save pacing
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setForm(() => toForm(stored));
                saving.reset();
              }}
            >
              Discard
            </Button>
          </Actions>
        )}
      </form>
      {draft && (
        <DraftForecast
          api={api}
          settings={settings}
          refresh={refresh}
          emptyHint="Fix the highlighted fields to see the forecast."
        />
      )}
      <Constants constants={stored.constants} />
    </div>
  );
}

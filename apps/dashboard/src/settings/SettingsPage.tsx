import { useCallback, useEffect, useRef, useState } from "react";
import { type AnalysisStatus, usd, useAnalysisState } from "../analysis.js";
import type { ApiClient } from "../api/client.js";
import type { Result } from "../api/result.js";
import { SpendMeter } from "../components/SpendMeter.js";
import { TopBar } from "../components/TopBar.js";
import { useSettingsDraft } from "../draft.js";
import type { EventStream } from "../events.js";
import { useHunt } from "../hunt-status.js";
import { useMutation } from "../mutation.js";
import type { CrawlConstants, CrawlSettings } from "../pacing.js";
import { changeLatest, type Doc, ifMatch, readDoc } from "../revision.js";
import type { Filters } from "../seeking.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Confirm.js";
import { NumberField, Segmented, SettingRow, TimeField, Toggle } from "../ui/controls.js";
import { Disclosure, Notice } from "../ui/status.js";
import { AdvancedCrawl } from "./AdvancedCrawl.js";
import { AnalysisSection } from "./AnalysisSection.js";
import { DataSection } from "./DataSection.js";
import { type AnalysisSettings, isAmount } from "./form.js";
import { PACES, type Pace, paceOf, withPace, withQuietHours } from "./pace.js";
import { ReadingProblem } from "./ReadingProblem.js";
import { SecretsSection } from "./SecretsSection.js";
import { Note, Problem } from "./Section.js";
import { useStored } from "./stored.js";
import { TokenSection } from "./TokenSection.js";
import { keepAnalysis, UnreadableSettings } from "./UnreadableSettings.js";

type StoredCrawl = CrawlSettings & { constants: CrawlConstants };
type Settled<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

const getCrawl = (api: ApiClient) => api.GET("/settings/crawl") as Settled<StoredCrawl>;

type CrawlChange = (latest: StoredCrawl) => { settings: CrawlSettings } | { problem: string };

const NOT_AN_AMOUNT = "Enter an amount, such as 5 or 12.50.";

const ads = (n: number) => `${n} ${n === 1 ? "ad" : "ads"}`;

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="wh-card settings-group" aria-label={title}>
      <h2 className="settings-heading">{title}</h2>
      {children}
    </section>
  );
}

export function SettingsPage({
  api,
  events,
  onSignOut,
}: {
  api: ApiClient;
  events: EventStream;
  onSignOut: () => void;
}) {
  const { view, hunt, pause, resume } = useHunt();
  const analysis = useAnalysisState();
  const hunting = useMutation(hunt?.state);
  const [pacingVersion, setPacingVersion] = useState(0);
  const drafts = useSettingsDraft();
  const draftKept = drafts.pacing !== null || drafts.analysis !== null;

  const crawl = useStored<Doc<StoredCrawl>>(useCallback(() => readDoc(() => getCrawl(api)), [api]));
  const model = useStored<Doc<AnalysisSettings>>(
    useCallback(() => readDoc(() => api.GET("/settings/analysis")), [api]),
  );
  const filters = useStored<Doc<Filters>>(
    useCallback(() => readDoc(() => api.GET("/filters")), [api]),
  );

  // Quiet hours and pace both PUT the whole crawl settings, so their saves run one at a time, each
  // made to what the one before saved: a quick second change can't undo the first. The read after
  // a pacing save waits its turn too, or an older copy could land over a later save.
  const latestCrawl = useRef<Doc<StoredCrawl> | undefined>(undefined);
  useEffect(() => {
    latestCrawl.current = crawl.value;
  }, [crawl.value]);
  const crawlSaves = useRef<Promise<unknown>>(Promise.resolve());

  function saveCrawl(change: CrawlChange): Promise<Result<undefined>> {
    const save = crawlSaves.current.then(async (): Promise<Result<undefined>> => {
      if (!latestCrawl.current)
        return { ok: false, message: "The hunting times aren't loaded yet." };
      const written = await changeLatest({
        start: latestCrawl.current,
        read: () => getCrawl(api),
        write: (body: CrawlSettings, revision) =>
          api.PUT("/settings/crawl", { body, params: ifMatch(revision) }) as Settled<StoredCrawl>,
        change: (latest) => {
          const next = change(latest);
          return "problem" in next ? next : { body: next.settings };
        },
      });
      if (!written.ok)
        return { ...written, message: written.errors?.[0]?.message ?? written.message };
      latestCrawl.current = written.data;
      crawl.replace(written.data);
      setPacingVersion((n) => n + 1);
      return { ok: true, data: undefined };
    });
    crawlSaves.current = save;
    return save;
  }

  function toggleHunting(on: boolean) {
    void hunting.run(on ? resume : pause);
  }

  return (
    <div className="settings-page">
      <TopBar title="Settings" />

      {hunting.state.status === "failed" && (
        <Notice tone="alarm" onDismiss={hunting.reset}>
          {hunting.state.message}
        </Notice>
      )}

      <Group title="Hunting">
        <SettingRow
          title="Keep hunting"
          description={
            hunt?.state === "cooldown"
              ? hunt.sentence
              : hunt?.state === "needs-you"
                ? hunt.sentence
                : undefined
          }
          control={
            <Toggle
              label="Keep hunting"
              checked={hunt?.on ?? false}
              disabled={hunting.busy || !hunt || hunt.control !== (hunt.on ? "pause" : "resume")}
              onChange={toggleHunting}
            />
          }
        />
        <QuietHours stored={crawl.value?.data} onSave={saveCrawl} />
        <HowOften stored={crawl.value?.data} onSave={saveCrawl} />
        <UnreadableSettings
          state={view.status === "ready" ? view.crawl.settings : undefined}
          onKeep={() => saveCrawl(({ constants: _, ...settings }) => ({ settings }))}
        />
        {crawl.state.status === "failed" && (
          <div className="settings-notices">
            <Problem
              message={`Couldn't load the hunting times: ${crawl.state.message}`}
              onRetry={crawl.retry}
            />
          </div>
        )}
      </Group>

      <Group title="Reading offers">
        <MonthlyLimit
          spend={analysis.view.status === "ready" ? analysis.view.analysis.spend : undefined}
          stored={model.value}
          api={api}
          onSaved={model.replace}
        />
        <HideScams api={api} filters={filters.value} onSaved={filters.replace} />
        {filters.state.status === "failed" && (
          <div className="settings-notices">
            <Problem
              message={`Couldn't load the Filters: ${filters.state.message}`}
              onRetry={filters.retry}
            />
          </div>
        )}
        <ReadingProblem />
        {analysis.view.status === "ready" && (
          <SettingRow
            title="Reading ads"
            description={
              analysis.view.analysis.awaiting > 0
                ? `Reading ${ads(analysis.view.analysis.awaiting)}…`
                : "No ads waiting."
            }
          />
        )}
        <ReadingNotices
          analysis={analysis.view.status === "ready" ? analysis.view.analysis : undefined}
        />
        <UnreadableSettings
          state={analysis.view.status === "ready" ? analysis.view.analysis.settings : undefined}
          onKeep={() => keepAnalysis(api, model.value, model.replace)}
        />
      </Group>

      <section className="wh-card settings-advanced" aria-label="Advanced">
        <Disclosure
          title="Advanced"
          defaultOpen={draftKept}
          hint="Activity, pacing, reading model, keys and stored data"
        >
          <div className="advanced-body">
            <AdvancedCrawl
              api={api}
              events={events}
              refresh={pacingVersion}
              onSaved={() => {
                crawlSaves.current = crawlSaves.current.then(async () => {
                  const fresh = await readDoc(() => getCrawl(api));
                  // On a failure the editor keeps what it saved; this copy catches up at the next load.
                  if (!fresh.ok) return;
                  latestCrawl.current = fresh.data;
                  crawl.replace(fresh.data);
                });
              }}
            />
            {model.value ? (
              <AnalysisSection api={api} stored={model.value} onSaved={model.replace} />
            ) : model.state.status === "failed" ? (
              <Problem
                message={`Couldn't load the reading model: ${model.state.message}`}
                onRetry={model.retry}
              />
            ) : (
              <Note role="status">Loading…</Note>
            )}
            <SecretsSection api={api} />
            <TokenSection api={api} />
            <DataSection api={api} />
          </div>
        </Disclosure>
      </section>

      <Group title="This browser">
        <SignOut onSignOut={onSignOut} />
      </Group>
    </div>
  );
}

function SignOut({ onSignOut }: { onSignOut: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <SettingRow
        title="Sign out"
        description="wg-hunt keeps hunting while you're signed out."
        control={
          <Button variant="secondary" icon="logout" onClick={() => setAsking(true)}>
            Sign out
          </Button>
        }
      />
      {asking && (
        <Confirm
          question="Sign out of wg-hunt?"
          confirmLabel="Sign out"
          danger
          onConfirm={onSignOut}
          onCancel={() => setAsking(false)}
        >
          wg-hunt keeps hunting. To come back to this dashboard, sign in again with your access
          token.
        </Confirm>
      )}
    </>
  );
}

function QuietHours({
  stored,
  onSave,
}: {
  stored: StoredCrawl | undefined;
  onSave: (change: CrawlChange) => Promise<Result<undefined>>;
}) {
  const from = stored?.pacing.activeHours.end ?? "";
  const until = stored?.pacing.activeHours.start ?? "";
  const [draft, setDraft] = useState<{ from?: string; until?: string } | null>(null);
  const saving = useMutation(`${from}-${until}`);
  const shown = { from: draft?.from ?? from, until: draft?.until ?? until };

  function commit(end: { from: string } | { until: string }) {
    if (!stored) return;
    const next = { ...draft, ...end };
    setDraft(next);
    void saving.run(async () => {
      // An end left untouched is the latest saved, not the copy read when Settings opened, so a
      // change made to it since in another tab or by an agent is kept.
      const saved = await onSave((latest) =>
        withQuietHours(
          latest,
          next.from ?? latest.pacing.activeHours.end,
          next.until ?? latest.pacing.activeHours.start,
        ),
      );
      if (saved.ok) setDraft(null);
      return saved;
    });
  }

  return (
    <SettingRow
      layout="field"
      title="Quiet hours"
      description={
        saving.state.status === "failed" ? saving.state.message : "No checks between these times."
      }
      control={
        <span className="settings-times">
          <TimeField
            hideLabel
            label="Quiet hours start"
            value={shown.from}
            disabled={!stored || saving.busy}
            onChange={(from) => commit({ from })}
          />
          <span aria-hidden="true">–</span>
          <TimeField
            hideLabel
            label="Quiet hours end"
            value={shown.until}
            disabled={!stored || saving.busy}
            onChange={(until) => commit({ until })}
          />
        </span>
      }
    />
  );
}

function HowOften({
  stored,
  onSave,
}: {
  stored: StoredCrawl | undefined;
  onSave: (change: CrawlChange) => Promise<Result<undefined>>;
}) {
  // Nothing is chosen until the stored pace is known: a guess would look saved.
  const saved = stored ? paceOf(stored) : undefined;
  const saving = useMutation(saved);
  const [picked, setPicked] = useState<Pace>();
  const pace = saving.busy && picked ? picked : saved;
  return (
    <SettingRow
      layout="field"
      title="How often to look"
      description={
        saving.state.status === "failed"
          ? saving.state.message
          : pace === "custom"
            ? "Custom, set under Advanced"
            : undefined
      }
      control={
        <Segmented<Pace | "custom">
          label="How often"
          value={pace}
          disabled={!stored || saving.busy}
          options={(Object.keys(PACES) as Pace[]).map((value) => ({
            value,
            label: PACES[value].label,
          }))}
          onChange={(value) => {
            if (!stored || value === "custom") return;
            setPicked(value);
            void saving.run(() => onSave((latest) => ({ settings: withPace(latest, value) })));
          }}
        />
      }
    />
  );
}

function MonthlyLimit({
  spend,
  stored,
  api,
  onSaved,
}: {
  spend: AnalysisStatus["spend"] | undefined;
  stored: Doc<AnalysisSettings> | undefined;
  api: ApiClient;
  onSaved: (settings: Doc<AnalysisSettings>) => void;
}) {
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);
  const saving = useMutation(stored?.data.monthlySpendCapUsd);
  const value = draft === undefined ? (stored?.data.monthlySpendCapUsd ?? null) : draft;
  const error = invalid
    ? NOT_AN_AMOUNT
    : saving.state.status === "failed"
      ? saving.state.message
      : undefined;
  // Enter and then leaving the field both commit; the second waits for the first and then finds
  // nothing left to send.
  const latest = useRef({ draft, stored });
  latest.current = { draft, stored };
  const committing = useRef<Promise<void>>(Promise.resolve());

  function commit() {
    committing.current = committing.current.then(send);
    return committing.current;
  }

  async function send() {
    const { draft: sent, stored: start } = latest.current;
    if (!start || sent === undefined) return;
    if (sent === null || !isAmount(String(sent))) return setInvalid(true);
    if (sent === start.data.monthlySpendCapUsd) {
      setDraft((now) => (now === sent ? undefined : now));
      // Commits run one at a time, so no save is on its way to be cut short here.
      return saving.reset();
    }
    await saving.run(async () => {
      const written = await changeLatest({
        start,
        read: () => api.GET("/settings/analysis"),
        write: (body: AnalysisSettings, revision) =>
          api.PUT("/settings/analysis", { body, params: ifMatch(revision) }),
        change: (now) => ({ body: { ...now, monthlySpendCapUsd: Number(sent) } }),
      });
      if (!written.ok) return written;
      // A commit queued behind this one runs before the next render: it must still find an amount
      // typed while this one was on its way, and the copy this one saved.
      const typed = latest.current.draft;
      latest.current = { draft: typed === sent ? undefined : typed, stored: written.data };
      onSaved(written.data);
      setDraft((now) => (now === sent ? undefined : now));
      return { ok: true, data: undefined };
    });
  }
  return (
    <SettingRow
      layout="field"
      title="Monthly limit for reading offers"
      description={
        spend && (
          <>
            {usd(spend.spentUsd)} of {usd(spend.capUsd)} used this month
            <SpendMeter spend={spend} />
          </>
        )
      }
      control={
        <NumberField
          bare
          prefix="$"
          suffix="a month"
          label="Monthly limit for reading offers"
          value={value}
          error={error}
          disabled={!stored}
          onChange={(next) => {
            setInvalid(false);
            // A save on its way keeps its pending state; its refusal is still to be shown.
            if (saving.state.status === "failed") saving.reset();
            setDraft(next);
          }}
          onBlur={() => void commit()}
          onEnter={() => void commit()}
        />
      }
    />
  );
}

function HideScams({
  api,
  filters,
  onSaved,
}: {
  api: ApiClient;
  filters: Doc<Filters> | undefined;
  onSaved: (filters: Doc<Filters>) => void;
}) {
  const saving = useMutation(filters?.data.hideLikelyScams.enabled);
  function change(enabled: boolean) {
    if (!filters) return;
    const start = filters;
    void saving.run(async () => {
      // Only this Filter changes: the rest is the latest saved, not the copy read when Settings
      // opened, so a Profile & Filters save or `wg.sh filters set` since is kept.
      const written = await changeLatest({
        start,
        read: () => api.GET("/filters"),
        write: (body: Filters, revision) =>
          api.PUT("/filters", { body, params: ifMatch(revision) }),
        change: (latest) => ({
          body: { ...latest, hideLikelyScams: { ...latest.hideLikelyScams, enabled } },
        }),
      });
      if (!written.ok) return written;
      onSaved(written.data);
      return { ok: true, data: undefined };
    });
  }
  return (
    <SettingRow
      title="Hide likely scams"
      description={
        saving.state.status === "failed" ? saving.state.message : "They stay under Warned."
      }
      control={
        <Toggle
          label="Hide likely scams"
          checked={filters?.data.hideLikelyScams.enabled ?? false}
          disabled={!filters || saving.busy}
          onChange={change}
        />
      }
    />
  );
}

function ReadingNotices({ analysis }: { analysis: AnalysisStatus | undefined }) {
  if (!analysis) return null;
  return (
    <div className="settings-notices">
      {analysis.key === "absent" && (
        <Notice tone="warn" title="Add a key so wg-hunt can read ads">
          New offers wait unread until there's an Anthropic API key under Advanced › Keys.
        </Notice>
      )}
      {analysis.key === "refused" && (
        <Notice tone="alarm" title="The Anthropic key was refused">
          New offers wait unread until you replace the key under Advanced › Keys.
        </Notice>
      )}
      {analysis.spend.state === "reached" && (
        <Notice tone="alarm" title="Monthly limit reached">
          New offers wait unread until next month, or until you raise the limit.
        </Notice>
      )}
      {analysis.spend.state === "waiting-for-in-flight" && (
        <Notice tone="warn" title="Monthly limit held by reads in progress">
          Ads being read right now could use the rest of the limit. New offers wait until they're
          done, and reading goes on by itself if that leaves room.
        </Notice>
      )}
      {analysis.olderVersion.count > 0 && (
        <Notice tone="info">
          {analysis.olderVersion.count} {analysis.olderVersion.count === 1 ? "ad was" : "ads were"}{" "}
          read with an older version. Read them again under Advanced › Reading model.
        </Notice>
      )}
    </div>
  );
}

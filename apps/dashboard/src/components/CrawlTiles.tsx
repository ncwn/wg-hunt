import type { ApiClient } from "../api/client.js";
import { kindLabel } from "../crawl-log.js";
import { type CrawlStatusView, formatBerlin } from "../crawl-status.js";
import type { EventStream } from "../events.js";
import { dailyLimitLabel, type ForecastState, useCurrentForecast } from "../forecast.js";
import { Problem } from "../settings/Section.js";
import { Notice } from "../ui/status.js";
import { ROWS } from "./DraftForecast.js";

const requests = (n: number) => `${n} ${n === 1 ? "request" : "requests"}`;

function Tile({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="adv-tile" aria-labelledby={id}>
      <h4 id={id} className="adv-tile-title">
        {title}
      </h4>
      {children}
    </section>
  );
}

function Waiting({ view }: { view: Exclude<CrawlStatusView, { status: "ready" }> }) {
  return (
    <p role="status" className="adv-note">
      {view.status === "loading" ? "Loading…" : "wg-hunt can't say right now. It will try again."}
    </p>
  );
}

export function TodayTile({ view }: { view: CrawlStatusView }) {
  return (
    <Tile id="tile-today" title="Today">
      {view.status !== "ready" ? (
        <Waiting view={view} />
      ) : (
        <>
          <div className="adv-figure-row">
            <span className="adv-label">Requests today</span>
            <span className="adv-figure wh-num">
              {view.crawl.counts.day.used}
              <span className="adv-figure-of"> / {view.crawl.counts.day.cap}</span>
            </span>
          </div>
          <meter
            className="adv-meter"
            aria-label="Requests today"
            min={0}
            max={view.crawl.counts.day.cap}
            value={Math.min(view.crawl.counts.day.used, view.crawl.counts.day.cap)}
          />
          <div className="adv-line">
            <span className="adv-label">This hour</span>
            <span className="wh-num">
              {view.crawl.counts.hour.used} / {view.crawl.counts.hour.cap}
            </span>
          </div>
          {view.crawl.halfBudgetUntil && (
            <p className="adv-note">
              Half pace until {formatBerlin(view.crawl.halfBudgetUntil)}, after a break.
            </p>
          )}
          {view.crawl.lastBotCheck && (
            <p className="adv-note">
              wg-gesucht last asked whether you're a person{" "}
              {formatBerlin(view.crawl.lastBotCheck.at)}, on{" "}
              <code className="adv-code">{view.crawl.lastBotCheck.path}</code>. It showed{" "}
              <code className="adv-code">{view.crawl.lastBotCheck.marker}</code> after{" "}
              {requests(view.crawl.lastBotCheck.hourCount)} that hour and{" "}
              {view.crawl.lastBotCheck.dayCount} that day.
            </p>
          )}
        </>
      )}
    </Tile>
  );
}

export function NextJobsTile({ view }: { view: CrawlStatusView }) {
  return (
    <Tile id="tile-next" title="Up next">
      {view.status !== "ready" ? (
        <Waiting view={view} />
      ) : view.crawl.nextJobs.length === 0 ? (
        <p className="adv-note">Nothing is queued.</p>
      ) : (
        <ol className="adv-jobs">
          {view.crawl.nextJobs.map((job) => (
            <li key={`${job.kind}${job.path}${job.dueAt}`}>
              <span className="adv-job-kind">{kindLabel(job.kind)}</span>
              <code className="adv-code" title={job.path}>
                {job.path}
              </code>
              <span className="adv-note">
                at <time dateTime={job.dueAt}>{formatBerlin(job.dueAt)}</time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Tile>
  );
}

function Rows({ state, onRetry }: { state: ForecastState; onRetry: () => void }) {
  if (state.status !== "ready") {
    return state.status === "failed" ? (
      <Problem message={state.message} onRetry={onRetry} />
    ) : (
      <p role="status" className="adv-note">
        Loading…
      </p>
    );
  }
  const { forecast } = state;
  return (
    <>
      <table className="adv-table">
        <caption className="wh-sr">Expected requests per day</caption>
        <tbody>
          {ROWS.map(({ key, label, hint }) => (
            <tr key={key}>
              <th scope="row" title={hint}>
                {label}
              </th>
              <td className="adv-cell-num wh-num">{forecast.requests[key]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="adv-note">
        {[
          dailyLimitLabel(forecast),
          !forecast.recheck.enabled && "Rechecks off",
          forecast.stretch.applied && `Checks spaced ${forecast.stretch.factor.toFixed(1)}× wider`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {forecast.warnings.map((warning) => (
        <Notice key={warning.type} tone="warn" role="alert">
          {warning.message}
        </Notice>
      ))}
    </>
  );
}

export function ForecastTile({
  api,
  refresh,
  events,
}: {
  api: ApiClient;
  refresh: unknown;
  events: EventStream;
}) {
  const { state, retry } = useCurrentForecast(api, refresh, events);
  return (
    <Tile id="tile-forecast" title="Expected per day">
      <Rows state={state} onRetry={retry} />
    </Tile>
  );
}

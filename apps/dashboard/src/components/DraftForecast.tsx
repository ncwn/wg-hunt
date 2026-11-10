import type { ApiClient } from "../api/client.js";
import {
  type DraftSearch,
  dailyLimitLabel,
  type Forecast,
  type ForecastBody,
  type ForecastState,
  useDraftForecast,
} from "../forecast.js";
import { Notice } from "../ui/status.js";

export const ROWS: { key: keyof Forecast["requests"]; label: string; hint: string }[] = [
  { key: "polls", label: "Polls", hint: "page 1 of each Search, and the pages after it" },
  { key: "sweeps", label: "Sweeps", hint: "the daily read of everything each Search matches" },
  { key: "newOffers", label: "New Offers", hint: "one detail page each" },
  { key: "confirmations", label: "Confirmations", hint: "Offers a Sweep did not see" },
  { key: "rechecks", label: "Left for Rechecks", hint: "what the daily cap leaves" },
];

type Props = {
  api: ApiClient;
  draft?: DraftSearch[] | undefined;
  settings?: ForecastBody["settings"];
  refresh?: unknown;
  emptyHint?: string;
  compact?: boolean;
};

function cell(state: ForecastState | undefined, pick: (f: Forecast) => string) {
  if (state?.status === "ready") return pick(state.forecast);
  return state?.status === "failed" ? "–" : "…";
}

export function DraftForecast({
  api,
  draft,
  settings,
  refresh,
  emptyHint = "Nothing to forecast yet.",
  compact = false,
}: Props) {
  const body: ForecastBody | undefined =
    draft === undefined && settings === undefined
      ? undefined
      : { ...(draft && { searches: draft }), ...(settings && { settings }) };
  const { now, draft: drafted } = useDraftForecast(api, body, refresh);
  const ready = drafted?.status === "ready" ? drafted.forecast : undefined;
  const current = now.status === "ready" ? now.forecast : undefined;

  const warnings = [
    ...(drafted?.status === "failed" ? [{ type: "failed", message: drafted.message }] : []),
    ...(ready?.warnings ?? []),
  ];

  const notices = warnings.map((warning) => (
    <Notice key={warning.type} tone="warn" role="alert">
      {warning.message}
    </Notice>
  ));
  if (compact) {
    return notices.length > 0 ? <div className="forecast-warnings">{notices}</div> : null;
  }

  return (
    <section className="forecast" aria-label="Requests per day">
      {notices}
      <h3 className="forecast-title">Requests per day</h3>
      {body === undefined ? (
        <p className="forecast-caption">{emptyHint}</p>
      ) : (
        <>
          <table className="forecast-table">
            <caption className="wh-sr">Expected requests per day, now and with this change</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="wh-sr">Kind of request</span>
                </th>
                <th scope="col">Now</th>
                <th scope="col">With this change</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(({ key, label, hint }) => {
                const before = current?.requests[key];
                const after = ready?.requests[key];
                const changed = before !== undefined && after !== undefined && before !== after;
                return (
                  <tr key={key}>
                    <th scope="row" title={hint}>
                      {label}
                    </th>
                    <td className="wh-num">{cell(now, (f) => String(f.requests[key]))}</td>
                    <td className={`wh-num${changed ? " forecast-changed" : ""}`}>
                      {cell(drafted, (f) => String(f.requests[key]))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {ready && (
            <p className="forecast-caption">
              {[
                dailyLimitLabel(ready),
                !ready.recheck.enabled && "Rechecks off",
                ready.stretch.applied && `Checks spaced ${ready.stretch.factor.toFixed(1)}× wider`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

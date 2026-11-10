import type { ApiClient } from "../api/client.js";
import { flagOf, formatLogTime, kindLabel, outcomeLabel, useRequestLog } from "../crawl-log.js";
import type { EventStream } from "../events.js";
import { Actions, Problem } from "../settings/Section.js";
import { Button } from "../ui/Button.js";
import { BandTag, Disclosure, Notice } from "../ui/status.js";

/**
 * Requests that stopped checking carry their outcome as a tag, so the word says it and the colour
 * only repeats it.
 */
export function RequestLog({ api, events }: { api: ApiClient; events: EventStream }) {
  const { state, older, reload } = useRequestLog(api, events);

  return (
    <section className="adv-fold" aria-label="Request log">
      <Disclosure title="Request log" hint="Last 30 days">
        {state.status === "loading" && (
          <p role="status" className="adv-note">
            Loading the request log…
          </p>
        )}

        {state.status === "failed" && <Problem message={state.message} onRetry={reload} />}

        {state.status === "ready" && state.items.length === 0 && (
          <p className="adv-note">No requests yet.</p>
        )}

        {state.status === "ready" && state.items.length > 0 && (
          <>
            <div className="adv-table-wrap">
              <table className="adv-table adv-log">
                <caption className="wh-sr">Request log</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Path</th>
                    <th scope="col">Status</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Marker</th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((request) => {
                    const flag = flagOf(request);
                    const outcome = outcomeLabel(request.outcome);
                    return (
                      <tr key={request.id} data-flag={flag}>
                        <th scope="row" className="wh-num">
                          <time dateTime={request.at}>{formatLogTime(request.at)}</time>
                        </th>
                        <td>{kindLabel(request.kind)}</td>
                        <td className="adv-log-path">
                          <code className="adv-code" title={request.path}>
                            {request.path}
                          </code>
                        </td>
                        <td className="wh-num">{request.status ?? "–"}</td>
                        <td>
                          {flag ? (
                            <BandTag band={flag === "bot-check" ? "warned" : "near"}>
                              {outcome}
                            </BandTag>
                          ) : (
                            outcome
                          )}
                        </td>
                        <td>
                          {request.marker ? (
                            <code className="adv-code">{request.marker}</code>
                          ) : (
                            "–"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {state.pagingFailed && (
              <Notice tone="alarm">Couldn't load older requests. Try again.</Notice>
            )}
            {state.more && (
              <Actions>
                <Button size="sm" variant="secondary" onClick={older} disabled={state.paging}>
                  Show older requests
                </Button>
              </Actions>
            )}
          </>
        )}
      </Disclosure>
    </section>
  );
}

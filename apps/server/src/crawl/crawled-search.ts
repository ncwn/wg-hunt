export type PollProblem = "unknown-city";

/**
 * Polls, Sweeps and the request budget all ask here, so a Search that sends nothing is charged
 * nothing.
 */
export function isCrawled(search: { enabled: boolean; problem: PollProblem | null }): boolean {
  return search.enabled && search.problem === null;
}

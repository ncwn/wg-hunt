export type PollProblem = "unknown-city";

export function isCrawled(search: { enabled: boolean; problem: PollProblem | null }): boolean {
  return search.enabled && search.problem === null;
}

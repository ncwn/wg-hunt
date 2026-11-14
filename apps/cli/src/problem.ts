/** Scripts and the agent skill (and its `wg.sh`) rely on these codes. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  notFound: 3,
  refused: 4,
  timedOut: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_BY_TYPE = {
  unauthorized: EXIT.error,
  "invalid-token": EXIT.error,
  "origin-not-allowed": EXIT.error,
  "not-found": EXIT.notFound,
  "not-known": EXIT.notFound,
  "offer-merged": EXIT.notFound,
  "bot-check-cooldown": EXIT.refused,
  "wipe-running": EXIT.refused,
  "search-disabled": EXIT.refused,
  "unknown-city": EXIT.refused,
  "offer-untracked": EXIT.refused,
  "no-api-key": EXIT.refused,
  "api-key-refused": EXIT.refused,
  "analysis-in-batch": EXIT.refused,
  "spend-cap-reached": EXIT.refused,
  "analysis-run-active": EXIT.refused,
  "nothing-to-reanalyze": EXIT.refused,
  "offer-has-one-ad": EXIT.refused,
  "stale-revision": EXIT.refused,
  "validation-error": EXIT.usage,
  "invalid-body": EXIT.usage,
  "invalid-cursor": EXIT.usage,
  "http-error": "by-status",
  "internal-error": EXIT.error,
  "usage-error": EXIT.usage,
  "not-configured": EXIT.error,
  "connection-failed": EXIT.error,
  "stream-ended": EXIT.error,
  "stream-reset": EXIT.error,
  "session-ended": EXIT.error,
  "token-not-saved": EXIT.error,
  "watch-timeout": EXIT.timedOut,
  "crawl-waits-for-resume": EXIT.refused,
  cancelled: EXIT.error,
} as const satisfies Record<string, ExitCode | "by-status">;

export const CLI_PROBLEM_TYPES = [
  "usage-error",
  "not-configured",
  "connection-failed",
  "stream-ended",
  "stream-reset",
  "session-ended",
  "token-not-saved",
  "watch-timeout",
  "crawl-waits-for-resume",
  "cancelled",
] as const satisfies (keyof typeof EXIT_BY_TYPE)[];

type ProblemType = keyof typeof EXIT_BY_TYPE;

/** An RFC 9457 problem. */
export type Problem = {
  type: string;
  title: string;
  status?: number;
  detail?: string;
  errors?: { path: string; message: string }[];
  [extension: string]: unknown;
};

export function exitCodeForStatus(status: number | undefined): ExitCode {
  if (status === 404) return EXIT.notFound;
  if (status === 409 || status === 412) return EXIT.refused;
  if (status === 400) return EXIT.usage;
  return EXIT.error;
}

export function exitCodeFor(problem: Pick<Problem, "type" | "status">): ExitCode {
  const known: ExitCode | "by-status" | undefined = Object.hasOwn(EXIT_BY_TYPE, problem.type)
    ? EXIT_BY_TYPE[problem.type as ProblemType]
    : undefined;
  return known === undefined || known === "by-status" ? exitCodeForStatus(problem.status) : known;
}

export class CliError extends Error {
  constructor(
    readonly problem: Problem,
    readonly exitCode: number,
    readonly raw?: string,
  ) {
    super(problem.detail ?? problem.title);
  }
}

export function cliProblem(
  type: (typeof CLI_PROBLEM_TYPES)[number],
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): CliError {
  const problem: Problem = { type, title, ...(detail !== undefined && { detail }), ...extra };
  return new CliError(problem, exitCodeFor(problem));
}

export function usageError(detail: string): CliError {
  return cliProblem("usage-error", "Usage error", detail);
}

export function setupError(type: "not-configured", title: string, detail: string): CliError {
  return cliProblem(type, title, detail);
}

export function problemFromResponse(status: number, body: unknown, raw: string): CliError {
  if (isProblem(body)) {
    return new CliError(body, exitCodeFor({ type: body.type, status: body.status ?? status }), raw);
  }
  const problem: Problem = { type: "http-error", title: `HTTP ${status}`, status };
  return new CliError(problem, exitCodeFor(problem));
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Problem).type === "string" &&
    typeof (value as Problem).title === "string"
  );
}

type FieldError = { path: string; message: string };

/** `status` is absent when no answer arrived or the dashboard refused before asking. */
export type Failed = {
  ok: false;
  message: string;
  status?: number;
  type?: string;
  errors?: FieldError[];
  body?: unknown;
};

export type Result<T> = { ok: true; data: T } | Failed;

export const UNREACHABLE = "Couldn't reach wg-hunt. Check that it is running, then try again.";

const GENERIC = "wg-hunt couldn't do that just now. Try again in a moment.";

function sentenceFor(status: number): string | undefined {
  if (status === 401) return "You're signed out. Sign in again to carry on.";
  if (status === 404) return "That isn't there any more.";
  if (status === 409) return "Something changed meanwhile. Try again.";
  if (status === 429) return "wg-hunt is busy. Try again in a minute.";
  if (status >= 500) return "wg-hunt ran into a problem. Try again in a moment.";
  return undefined;
}

// openapi-fetch hands back the raw text of an error body that is not JSON, such as a proxy's page.
const problemOf = (body: unknown): Record<string, unknown> | undefined =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;

const textOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

function messageOf(problem: unknown, status: number): string {
  const body = problemOf(problem);
  return textOf(body?.detail) ?? textOf(body?.title) ?? sentenceFor(status) ?? GENERIC;
}

/** A problem's `title` is a short label for its type, such as "Unauthorized": too bare to stand in for a screen's own sentence. */
export function wordsOf(failed: Failed): string | undefined {
  return textOf(problemOf(failed.body)?.detail);
}

function failedFrom(error: unknown, status: number): Failed {
  const problem = problemOf(error);
  const failed: Failed = { ok: false, message: messageOf(error, status), status };
  if (!problem) return failed;
  if (typeof problem.type === "string") failed.type = problem.type;
  if (Array.isArray(problem.errors)) failed.errors = problem.errors as FieldError[];
  failed.body = problem;
  return failed;
}

export type Answer<T> = { data?: T; error?: unknown; response: Response };

export function ask<T>(call: () => Promise<Answer<T>>): Promise<Result<T>>;
export function ask(
  call: () => Promise<Answer<unknown>>,
  options: { empty: true },
): Promise<Result<undefined>>;
export async function ask<T>(
  call: () => Promise<Answer<T>>,
  options?: { empty: true },
): Promise<Result<T | undefined>> {
  let answer: Answer<T>;
  try {
    answer = await call();
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  const { data, error, response } = answer;
  if (response.ok && options?.empty) return { ok: true, data: undefined };
  if (response.ok && data !== undefined) return { ok: true, data };
  return failedFrom(error, response.status);
}

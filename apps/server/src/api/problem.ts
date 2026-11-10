import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { relativeToProject } from "../config.js";

export const PROBLEMS = {
  unauthorized: { status: 401, title: "Unauthorized" },
  "invalid-token": { status: 401, title: "Invalid access token" },
  "origin-not-allowed": { status: 403, title: "Origin not allowed" },
  "not-found": { status: 404, title: "Not found" },
  "offer-merged": { status: 404, title: "Offer was merged into another" },
  "not-known": { status: 404, title: "Not known" },
  "bot-check-cooldown": { status: 409, title: "Bot check Cooldown in progress" },
  "wipe-running": { status: 409, title: "Offer data is being deleted" },
  "search-disabled": { status: 409, title: "Search is disabled" },
  "unknown-city": { status: 409, title: "City not recognised" },
  "offer-untracked": { status: 409, title: "Offer is not Tracked" },
  "no-api-key": { status: 409, title: "No Anthropic API key is set" },
  "api-key-refused": { status: 409, title: "The Anthropic API refused the key that is set" },
  "analysis-in-batch": { status: 409, title: "Offer is already being read in a batch" },
  "spend-cap-reached": { status: 409, title: "Spend cap reached" },
  "analysis-run-active": { status: 409, title: "A re-analysis run is already going" },
  "nothing-to-reanalyze": { status: 409, title: "No Offer is on an older analysis" },
  "offer-has-one-ad": { status: 409, title: "Offer has only one Ad ID" },
  "stale-revision": { status: 412, title: "Changed since it was read" },
  "validation-error": { status: 400, title: "Invalid request" },
  "invalid-body": { status: 400, title: "Invalid request body" },
  "invalid-cursor": { status: 400, title: "Invalid cursor" },
  // Raised by Hono itself; the status comes from the exception, not from here.
  "http-error": { status: 500, title: "HTTP error" },
  "internal-error": { status: 500, title: "Internal server error" },
} as const satisfies Record<string, { status: ContentfulStatusCode; title: string }>;

export type ProblemType = keyof typeof PROBLEMS;

/** `path` is dotted, such as `pollInterval.maxMinutes`; empty for the whole body. */
export type FieldError = { path: string; message: string };

export type ProblemExtensions = { mergedInto?: number };

/** RFC 9457 problem details; `type` is a stable slug such as `not-found`. */
export class ProblemError extends Error {
  constructor(
    readonly type: ProblemType,
    readonly detail?: string,
    readonly errors?: FieldError[],
    readonly extensions?: ProblemExtensions,
  ) {
    super(detail ?? PROBLEMS[type].title);
  }
}

const problemSchema = z
  .object({
    type: z.string().openapi({ example: "not-found" }),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .openapi({ description: "On `validation-error`: each invalid input and why." }),
    mergedInto: z.number().int().optional().openapi({
      description:
        "On `offer-merged`: the id of the Offer that holds the absorbed Offer's room now.",
    }),
  })
  .openapi("Problem");

export function fieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.flatMap((issue): FieldError[] => {
    const path = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: [...path, key].join("."),
        message: "This field isn't recognised",
      }));
    }
    return [{ path: path.join("."), message: issue.message }];
  });
}

export function problemResponses(...types: ProblemType[]) {
  const byStatus: Record<number, ProblemType[]> = {};
  for (const type of types) {
    const status = PROBLEMS[type].status;
    byStatus[status] = [...(byStatus[status] ?? []), type];
  }
  return Object.fromEntries(
    Object.entries(byStatus).map(([status, slugs]) => [
      status,
      {
        description: slugs.map((t) => `\`${t}\`: ${PROBLEMS[t].title}`).join("; "),
        content: { "application/problem+json": { schema: problemSchema } },
      },
    ]),
  );
}

export function problemResponse(
  c: Context,
  type: ProblemType,
  detail?: string,
  status: ContentfulStatusCode = PROBLEMS[type].status,
  errors?: FieldError[],
  extensions?: ProblemExtensions,
) {
  const body = {
    type,
    title: PROBLEMS[type].title,
    status,
    ...(detail && { detail }),
    ...(errors && { errors }),
    ...extensions,
  };
  return c.body(JSON.stringify(body), status, {
    "Content-Type": "application/problem+json",
    ...(type === "unauthorized" && { "WWW-Authenticate": "Bearer" }),
  });
}

// Absolute paths outside the project root, minus API paths such as /api/v1/offers.
const ABSOLUTE_PATH = /(?<![\w/.])\/(?!api\/)[\w.@+-]+(?:\/[\w.@+-]+)+/g;

export function scrubPaths(text: string, projectRoot: string): string {
  return text
    .replaceAll(`${projectRoot}/`, "")
    .replaceAll(ABSOLUTE_PATH, (path) => relativeToProject(path, projectRoot));
}

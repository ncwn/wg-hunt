import { createRoute, z } from "@hono/zod-openapi";
import { noteKeySaved } from "../analysis/key.js";
import {
  clearSecret,
  isSecretName,
  SECRET_NAMES,
  type SecretHint,
  type SecretName,
  secretHint,
  writeSecret,
} from "../secrets.js";
import type { ApiModule } from "./context.js";
import { ProblemError, problemResponses } from "./problem.js";

const MAX_SECRET_LENGTH = 512;

const secretSchema = z
  .object({
    name: z.enum(SECRET_NAMES),
    set: z.boolean(),
    masked: z.string().nullable().openapi({ example: "sk-ant-…a1b2" }),
    updatedAt: z.iso.datetime().nullable(),
  })
  .openapi("Secret");

const nameParam = z.object({
  name: z.string().openapi({ param: { name: "name", in: "path" }, example: "anthropic" }),
});

// The messages never quote the value.
const valueSchema = z
  .string()
  .trim()
  .min(1, "The value is empty.")
  .max(MAX_SECRET_LENGTH, `The value is longer than ${MAX_SECRET_LENGTH} characters.`)
  .regex(/^\S+$/, "The value must not contain spaces or line breaks.");

const listRoute = createRoute({
  method: "get",
  path: "/secrets",
  tags: ["Secrets and access"],
  summary: "Which secrets are set, each as a masked hint. Values are never returned",
  responses: {
    200: {
      description: "One entry per secret wg-hunt keeps",
      content: { "application/json": { schema: z.array(secretSchema) } },
    },
  },
});

const setRoute = createRoute({
  method: "put",
  path: "/secrets/{name}",
  tags: ["Secrets and access"],
  summary: "Set or replace a secret. The value is write-only",
  description:
    "Saving the Anthropic key, the same value included, ends a refusal (`key: refused` on `GET /analysis`): the key is tried again.",
  request: {
    params: nameParam,
    body: {
      content: { "application/json": { schema: z.object({ value: valueSchema }) } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The secret is set; this is its masked hint",
      content: { "application/json": { schema: secretSchema } },
    },
    ...problemResponses("not-found", "validation-error", "invalid-body", "origin-not-allowed"),
  },
});

const clearRoute = createRoute({
  method: "delete",
  path: "/secrets/{name}",
  tags: ["Secrets and access"],
  summary: "Clear a secret; clearing one that is not set is not an error",
  request: { params: nameParam },
  responses: {
    204: { description: "The secret is not set" },
    ...problemResponses("not-found", "origin-not-allowed"),
  },
});

function known(name: string): SecretName {
  if (!isSecretName(name))
    throw new ProblemError("not-found", "There is no secret with that name.");
  return name;
}

const toJson = (hint: SecretHint) => ({
  ...hint,
  updatedAt: hint.updatedAt?.toISOString() ?? null,
});

export const registerSecrets: ApiModule = (api, { db, analysis }) => {
  api.openapi(listRoute, (c) =>
    c.json(
      SECRET_NAMES.map((name) => toJson(secretHint(db, name))),
      200,
    ),
  );

  api.openapi(setRoute, (c) => {
    const name = known(c.req.valid("param").name);
    writeSecret(db, name, c.req.valid("json").value);
    if (name === "anthropic") {
      noteKeySaved(db);
      analysis.syncStatus();
      analysis.poke();
    }
    return c.json(toJson(secretHint(db, name)), 200);
  });

  api.openapi(clearRoute, (c) => {
    const name = known(c.req.valid("param").name);
    clearSecret(db, name);
    if (name === "anthropic") analysis.syncStatus();
    return c.body(null, 204);
  });
};

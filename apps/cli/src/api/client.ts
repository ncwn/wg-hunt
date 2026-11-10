import createClient from "openapi-fetch";
import { cliProblem, problemFromResponse } from "../problem.js";
import type { paths } from "./schema.js";

export type Reply<T> = { status: number; data: T; text: string; headers: Headers };

type Settled<T> = { data?: T; error?: unknown; response: Response };

export type Api = {
  client: ReturnType<typeof createClient<paths>>;
  send<T>(call: Promise<Settled<T>>): Promise<Reply<T>>;
};

export function createApi({
  url,
  token,
  fetch,
}: {
  url: string;
  token?: string;
  fetch: (request: Request) => Promise<Response>;
}): Api {
  const bodies = new WeakMap<Response, string>();

  const client = createClient<paths>({
    baseUrl: `${url.replace(/\/+$/, "")}/api/v1`,
    ...(token && { headers: { Authorization: `Bearer ${token}` } }),
    fetch: async (request) => {
      let response: Response;
      try {
        response = await fetch(request);
      } catch (err) {
        // A request the caller called off (Ctrl-C, `watch --timeout`) is not a server that is down.
        if (request.signal.aborted) throw err;
        throw cliProblem(
          "connection-failed",
          "Could not reach the server",
          `${err instanceof Error ? err.message : "request failed"} (${url})`,
        );
      }
      // A live stream is handed on as it is. Anything else is read here, so that what the CLI
      // prints under --json is the server's own text, not a re-serialisation of it.
      if (response.headers.get("content-type")?.includes("text/event-stream")) return response;
      const text = await response.text();
      const copy = new Response(text === "" ? null : text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      bodies.set(copy, text);
      return copy;
    },
  });

  async function send<T>(call: Promise<Settled<T>>): Promise<Reply<T>> {
    const { data, error, response } = await call;
    const text = bodies.get(response) ?? "";
    if (!response.ok) throw problemFromResponse(response.status, error, text);
    return { status: response.status, data: data as T, text, headers: response.headers };
  }

  return { client, send };
}

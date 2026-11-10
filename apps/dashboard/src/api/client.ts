import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema.js";

export type ApiClient = ReturnType<typeof createApiClient>;

export type ApiClientOptions = {
  /** The dashboard is served from the same origin, so a path is enough. */
  baseUrl?: string;
  fetch?: (request: Request) => Promise<Response>;
};

export function createApiClient({ baseUrl = "/api/v1", fetch }: ApiClientOptions = {}) {
  return createClient<paths>({ baseUrl, ...(fetch && { fetch }) });
}

export type SessionWatch = {
  stop(): void;
  /**
   * Resolves once every token rotation this dashboard sent has its answer. That answer carries the
   * renewed cookie, so a session check made before it lands would wrongly get 401.
   */
  rotationsSettled(): Promise<void>;
};

const isPath = (request: Request, method: string, path: string) =>
  request.method === method && new URL(request.url).pathname.endsWith(path);

/**
 * A wrong token at login has no session to lose, and a 401 to a request sent before the latest
 * sign-in or rotation answered is stale: it was refused under the cookie that answer replaced.
 */
export function watchSession(api: ApiClient, onLost: () => void): SessionWatch {
  let sent = 0;
  // Requests numbered up to this one went out under a cookie that has since been replaced.
  let renewedAfter = 0;
  const numbers = new Map<string, number>();
  let rotating = 0;
  const waiting: (() => void)[] = [];

  function rotationDone() {
    rotating -= 1;
    if (rotating > 0) return;
    for (const resolve of waiting.splice(0)) resolve();
  }

  const middleware: Middleware = {
    onRequest({ request, id }) {
      numbers.set(id, ++sent);
      if (isPath(request, "POST", "/auth/token/rotate")) rotating += 1;
    },
    onResponse({ request, response, id }) {
      const number = numbers.get(id) ?? sent;
      numbers.delete(id);
      const login = isPath(request, "POST", "/auth/session");
      const rotation = isPath(request, "POST", "/auth/token/rotate");
      if (rotation) rotationDone();
      if ((login || rotation) && response.ok) renewedAfter = sent;
      if (response.status === 401 && !login && number > renewedAfter) onLost();
    },
    onError({ request, id }) {
      numbers.delete(id);
      if (isPath(request, "POST", "/auth/token/rotate")) rotationDone();
    },
  };
  api.use(middleware);
  return {
    stop: () => api.eject(middleware),
    rotationsSettled: () =>
      rotating === 0 ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve)),
  };
}

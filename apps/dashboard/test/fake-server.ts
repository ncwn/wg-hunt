import type { components } from "../src/api/schema.js";

export type CrawlStatus = components["schemas"]["CrawlStatus"];

type Derived = "holds" | "nextRequest" | "actions";

function derive(base: Omit<CrawlStatus, Derived>, given: Partial<CrawlStatus>): CrawlStatus {
  const holds: CrawlStatus["holds"] = given.holds ?? [
    ...(base.paused
      ? [base.paused.reason === "user" ? ("paused" as const) : base.paused.reason]
      : []),
    ...(base.cooldown?.needsResume ? (["needs-resume"] as const) : []),
  ];
  const cooling = base.state === "cooling-down";
  const resume = !cooling && holds.length > 0;
  const nextRequest: CrawlStatus["nextRequest"] =
    given.nextRequest ??
    (holds.length > 0
      ? { at: null, waitingFor: cooling ? "cooldown" : (holds[0] ?? null) }
      : cooling
        ? { at: base.cooldown?.until ?? null, waitingFor: "cooldown" }
        : { at: null, waitingFor: null });
  return {
    ...base,
    holds,
    nextRequest,
    actions: given.actions ?? { pause: base.paused === null && !resume, resume },
  };
}

export function crawlStatus(change: Partial<CrawlStatus> = {}): CrawlStatus {
  const { holds: _h, nextRequest: _n, actions: _a, ...rest } = change;
  return derive(
    {
      state: "running",
      cooldown: null,
      paused: null,
      halfBudgetUntil: null,
      counts: { hour: { used: 3, cap: 30 }, day: { used: 12, cap: 300 } },
      nextJobs: [],
      lastBotCheck: null,
      settings: { source: "saved", unreadable: [] },
      ...rest,
    },
    change,
  );
}

function changed(crawl: CrawlStatus, change: Partial<CrawlStatus>): CrawlStatus {
  const { holds: _h, nextRequest: _n, actions: _a, ...base } = crawl;
  return crawlStatus({ ...base, ...change });
}

export function fakeServer(
  options: { token?: string; signedIn?: boolean; crawl?: CrawlStatus } = {},
) {
  const state = {
    signedIn: options.signedIn ?? false,
    requests: [] as string[],
    crawl: options.crawl ?? crawlStatus(),
    refuseResume: undefined as string | undefined,
  };
  const token = options.token ?? "correct-token";

  const problem = (type: string, status: number, detail?: string) =>
    new Response(JSON.stringify({ type, title: type, status, ...(detail && { detail }) }), {
      status,
      headers: { "Content-Type": "application/problem+json" },
    });
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

  const fetch = async (input: Request): Promise<Response> => {
    const url = new URL(input.url);
    state.requests.push(`${input.method} ${url.pathname}`);
    if (url.pathname === "/api/v1/crawl" && input.method === "GET") return json(state.crawl);
    if (url.pathname === "/api/v1/offers" && input.method === "GET") {
      return json({ items: [], nextCursor: null });
    }
    if (url.pathname === "/api/v1/crawl/pause" && input.method === "POST") {
      state.crawl = changed(state.crawl, {
        state: state.crawl.state === "running" ? "paused" : state.crawl.state,
        paused: {
          reason: "user",
          cause: null,
          since: new Date().toISOString(),
          path: null,
          savedAs: null,
        },
      });
      return json(state.crawl);
    }
    if (url.pathname === "/api/v1/crawl/resume" && input.method === "POST") {
      if (state.refuseResume) return problem("bot-check-cooldown", 409, state.refuseResume);
      state.crawl = changed(state.crawl, { state: "running", paused: null, cooldown: null });
      return json(state.crawl);
    }
    if (url.pathname === "/api/v1/offers/counts" && input.method === "GET") {
      return json({ bands: { match: 0, "near-match": 0, warned: 0, hidden: 0 }, new: 0 });
    }
    if (url.pathname !== "/api/v1/auth/session") return problem("not-found", 404);
    if (input.method === "GET") {
      return state.signedIn ? new Response(null, { status: 204 }) : problem("unauthorized", 401);
    }
    if (input.method === "POST") {
      const body = (await input.json()) as { token: string };
      if (body.token !== token) return problem("invalid-token", 401);
      state.signedIn = true;
      return new Response(null, { status: 204 });
    }
    if (input.method === "DELETE") {
      state.signedIn = false;
      return new Response(null, { status: 204 });
    }
    return problem("not-found", 404);
  };

  return { fetch, state, token };
}

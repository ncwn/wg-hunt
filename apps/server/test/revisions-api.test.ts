import { describe, expect, it } from "vitest";
import { bootTestApp } from "./helpers.js";

type App = ReturnType<typeof bootTestApp>["app"];

const DOCUMENTS = ["/profile", "/filters", "/settings/crawl", "/settings/analysis"] as const;

function api(app: App, token: string) {
  const base = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    get: (path: string) => app.request(`/api/v1${path}`, { headers: base }),
    put: (path: string, body: unknown, ifMatch?: string) =>
      app.request(`/api/v1${path}`, {
        method: "PUT",
        headers: { ...base, ...(ifMatch !== undefined && { "If-Match": ifMatch }) },
        body: JSON.stringify(body),
      }),
  };
}

async function editable(res: Response): Promise<Record<string, unknown>> {
  const { constants: _constants, ...rest } = (await res.json()) as Record<string, unknown>;
  return rest;
}

describe("document revisions", () => {
  it.each(DOCUMENTS)("GET and PUT %s send an ETag that changes with the content", async (path) => {
    const { app, token } = bootTestApp();
    const client = api(app, token);
    const first = await client.get(path);
    const etag = first.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

    const body = await editable(first);
    const same = await client.put(path, body, etag ?? "");
    expect(same.status).toBe(200);
    expect(same.headers.get("ETag")).toBe(etag);
    expect((await client.get(path)).headers.get("ETag")).toBe(etag);
  });

  it.each(DOCUMENTS)("PUT %s with no If-Match still replaces the document", async (path) => {
    const { app, token } = bootTestApp();
    const client = api(app, token);
    const body = await editable(await client.get(path));
    expect((await client.put(path, body)).status).toBe(200);
  });

  it("refuses a Filters write made from an older read: the lost-update sequence", async () => {
    const { app, token } = bootTestApp();
    const client = api(app, token);

    const read = await client.get("/filters");
    const revision = read.headers.get("ETag") ?? "";
    const draft = (await read.json()) as Record<string, Record<string, unknown>>;
    const tightened = { ...draft, maxRent: { ...draft.maxRent, enabled: true, limit: 650 } };

    const elsewhere = (await (await client.get("/filters")).json()) as typeof draft;
    const scamsOn = {
      ...elsewhere,
      hideLikelyScams: { ...elsewhere.hideLikelyScams, enabled: true },
    };
    const other = await client.put("/filters", scamsOn, revision);
    expect(other.status).toBe(200);
    expect(other.headers.get("ETag")).not.toBe(revision);

    const stale = await client.put("/filters", tightened, revision);
    expect(stale.status).toBe(412);
    expect(stale.headers.get("Content-Type")).toContain("application/problem+json");
    expect(await stale.json()).toMatchObject({ type: "stale-revision", status: 412 });

    const now = (await (await client.get("/filters")).json()) as typeof draft;
    expect(now.hideLikelyScams?.enabled).toBe(true);
    expect(now.maxRent?.limit).toBeNull();
  });

  it.each(DOCUMENTS)(
    "PUT %s refuses an If-Match that is not the current revision",
    async (path) => {
      const { app, token } = bootTestApp();
      const client = api(app, token);
      const body = await editable(await client.get(path));
      const res = await client.put(path, body, '"0000000000000000"');
      expect(res.status).toBe(412);
      expect(await res.json()).toMatchObject({ type: "stale-revision" });
    },
  );

  it("takes a list of revisions or a wildcard in If-Match", async () => {
    const { app, token } = bootTestApp();
    const client = api(app, token);
    const read = await client.get("/profile");
    const etag = read.headers.get("ETag") ?? "";
    const body = await read.json();
    expect((await client.put("/profile", body, `"0000000000000000", ${etag}`)).status).toBe(200);
    expect((await client.put("/profile", body, "*")).status).toBe(200);
  });

  it("takes an If-Match tag without its quotes, and refuses a stale one", async () => {
    const { app, token } = bootTestApp();
    const client = api(app, token);
    const read = await client.get("/filters");
    const bare = (read.headers.get("ETag") ?? "").replaceAll('"', "");
    const body = await read.json();
    expect((await client.put("/filters", body, bare)).status).toBe(200);

    const stale = await client.put("/filters", body, "0000000000000000");
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ type: "stale-revision" });
  });

  it.each(DOCUMENTS)(
    "PUT %s takes back the ETag of a gzipped read, which compression marks weak",
    async (path) => {
      const { app, token } = bootTestApp();
      const client = api(app, token);
      // Browsers and Node's fetch ask for gzip, and compression turns `"…"` into `W/"…"`.
      const read = await app.request(`/api/v1${path}`, {
        headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip" },
      });
      expect(read.headers.get("Content-Encoding")).toBe("gzip");
      const etag = read.headers.get("ETag") ?? "";
      expect(etag).toMatch(/^W\/"[0-9a-f]{16}"$/);
      const body = await editable(
        new Response(read.body?.pipeThrough(new DecompressionStream("gzip"))),
      );

      expect((await client.put(path, body, etag)).status).toBe(200);

      const changed = await client.put(path, body, 'W/"0000000000000000"');
      expect(changed.status).toBe(412);
      expect(await changed.json()).toMatchObject({ type: "stale-revision" });
    },
  );
});

describe("PUT /seeking revisions", () => {
  type Doc = Record<string, Record<string, unknown>>;

  async function read(client: ReturnType<typeof api>) {
    const [profile, filters] = await Promise.all([client.get("/profile"), client.get("/filters")]);
    return {
      profile: (await profile.json()) as Doc,
      filters: (await filters.json()) as Doc,
      revisions: {
        profile: profile.headers.get("ETag") ?? "",
        filters: filters.headers.get("ETag") ?? "",
      },
    };
  }

  const changed = (seen: Awaited<ReturnType<typeof read>>) => ({
    profile: { ...seen.profile, age: 31 },
    filters: { ...seen.filters, maxRent: { ...seen.filters.maxRent, enabled: true, limit: 650 } },
  });

  it("refuses the whole write when the Filters changed since they were read, and saves nothing", async () => {
    const { app, token } = bootTestApp();
    const client = api(app, token);
    const seen = await read(client);
    const scamsOn = {
      ...seen.filters,
      hideLikelyScams: { ...seen.filters.hideLikelyScams, enabled: true },
    };
    expect((await client.put("/filters", scamsOn)).status).toBe(200);

    const stale = await client.put("/seeking", { ...changed(seen), revisions: seen.revisions });
    expect(stale.status).toBe(412);
    const problem = await stale.json();
    expect(problem).toMatchObject({ type: "stale-revision" });
    expect(problem.detail).toMatch(/^The Filters were changed/);

    const now = await read(client);
    expect(now.revisions.profile).toBe(seen.revisions.profile);
    expect(now.filters.hideLikelyScams?.enabled).toBe(true);
    expect(now.filters.maxRent?.limit).toBeNull();
  });

  it("refuses the whole write when the Profile changed since it was read, and saves nothing", async () => {
    const { app, token } = bootTestApp();
    const client = api(app, token);
    const seen = await read(client);
    expect((await client.put("/profile", { ...seen.profile, age: 40 })).status).toBe(200);

    const stale = await client.put("/seeking", { ...changed(seen), revisions: seen.revisions });
    expect(stale.status).toBe(412);
    expect((await stale.json()).detail).toMatch(/^The Seeker Profile was changed/);

    const now = await read(client);
    expect(now.profile.age).toBe(40);
    expect(now.revisions.filters).toBe(seen.revisions.filters);
  });

  it("checks a revision for a half the write leaves out", async () => {
    const { app, token } = bootTestApp();
    const client = api(app, token);
    const seen = await read(client);
    expect((await client.put("/filters", changed(seen).filters)).status).toBe(200);

    const res = await client.put("/seeking", {
      profile: changed(seen).profile,
      revisions: { filters: seen.revisions.filters },
    });
    expect(res.status).toBe(412);
    expect((await read(client)).revisions.profile).toBe(seen.revisions.profile);
  });

  it("takes a weak or a bare revision, and replaces without one", async () => {
    const { app, token } = bootTestApp();
    const client = api(app, token);
    const seen = await read(client);
    const weak = await client.put("/seeking", {
      ...changed(seen),
      revisions: {
        profile: `W/${seen.revisions.profile}`,
        filters: seen.revisions.filters.replaceAll('"', ""),
      },
    });
    expect(weak.status).toBe(200);
    expect((await client.put("/seeking", { profile: seen.profile })).status).toBe(200);
  });

  it("answers with revisions that work as If-Match on the single routes", async () => {
    const { app, token } = bootTestApp();
    const client = api(app, token);
    const seen = await read(client);
    const saved = await client.put("/seeking", changed(seen));
    const { profile, filters, revisions } = await saved.json();
    expect(revisions).toEqual((await read(client)).revisions);
    expect((await client.put("/profile", profile, revisions.profile)).status).toBe(200);
    expect((await client.put("/filters", filters, revisions.filters)).status).toBe(200);
  });
});

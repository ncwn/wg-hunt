import { describe, expect, it } from "vitest";
import { bootTestApp, tempDataDir } from "./helpers.js";

function searchesApi(runtime = bootTestApp()) {
  const call = (method: string, path: string, body?: unknown) =>
    runtime.app.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { runtime, call };
}

const berlin = { city: "Berlin", categories: ["flatshare-room", "one-room-flat"] };

describe("creating a Search", () => {
  it("stores it on the wg-gesucht Source with the default window, rent types and poll interval", async () => {
    const { call } = searchesApi();
    const created = await call("POST", "/searches", berlin);
    expect(created.status).toBe(201);
    const search = await created.json();
    expect(search).toEqual({
      id: expect.any(Number),
      source: "wg-gesucht",
      city: "Berlin",
      cityId: null,
      poll: { nextAt: expect.any(String), problem: null },
      sweep: {
        status: "scheduled",
        mode: "backfill",
        startAt: expect.any(String),
        pagesRead: 0,
        lastFinishedAt: null,
      },
      categories: ["flatshare-room", "one-room-flat"],
      rentTypes: ["unlimited", "limited", "overnight"],
      priceCeiling: null,
      recencyDays: 7,
      enabled: true,
      pollInterval: { minMinutes: 30, maxMinutes: 60 },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const fetched = await call("GET", `/searches/${search.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(search);
  });

  it("keeps every field it was given", async () => {
    const { call } = searchesApi();
    const body = {
      source: "wg-gesucht",
      city: "München",
      categories: ["flat", "house"],
      rentTypes: ["unlimited"],
      priceCeiling: 800,
      recencyDays: 3,
      enabled: false,
      pollInterval: { minMinutes: 45, maxMinutes: 90 },
    };
    const res = await call("POST", "/searches", body);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject(body);
  });

  it("requires the access token", async () => {
    const { runtime } = searchesApi();
    const res = await runtime.app.request("/api/v1/searches");
    expect(res.status).toBe(401);
  });
});

describe("listing Searches", () => {
  it("lists them oldest first and pages with a cursor", async () => {
    const { call } = searchesApi();
    for (const city of ["Berlin", "Hamburg", "Köln"]) {
      await call("POST", "/searches", { ...berlin, city });
    }

    const first = await (await call("GET", "/searches?limit=2")).json();
    expect(first.items.map((s: { city: string }) => s.city)).toEqual(["Berlin", "Hamburg"]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await (await call("GET", `/searches?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((s: { city: string }) => s.city)).toEqual(["Köln"]);
    expect(second.nextCursor).toBeNull();
  });

  it("is empty before anything is created", async () => {
    const { call } = searchesApi();
    expect(await (await call("GET", "/searches")).json()).toEqual({ items: [], nextCursor: null });
  });

  it("refuses a cursor that did not come from this list", async () => {
    const { call } = searchesApi();
    const res = await call("GET", "/searches?cursor=%25%25%25");
    expect(res.status).toBe(400);
    expect((await res.json()).type).toBe("invalid-cursor");
  });
});

describe("invalid input", () => {
  type FieldError = { path: string; message: string };

  async function rejected(body: unknown) {
    const { call } = searchesApi();
    const res = await call("POST", "/searches", body);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const problem = await res.json();
    expect(problem).toMatchObject({ type: "validation-error", status: 400 });
    return problem as { errors: FieldError[] };
  }

  it("rejects a recency window over 1 week, naming the field", async () => {
    const problem = await rejected({ ...berlin, recencyDays: 8 });
    expect(problem.errors).toEqual([{ path: "recencyDays", message: expect.any(String) }]);
  });

  it("rejects an unknown category, naming the field", async () => {
    const problem = await rejected({ ...berlin, categories: ["flatshare-room", "castle"] });
    expect(problem.errors.map((e) => e.path)).toEqual(["categories.1"]);
  });

  it("rejects an empty category list", async () => {
    const problem = await rejected({ ...berlin, categories: [] });
    expect(problem.errors).toEqual([{ path: "categories", message: "Pick at least one category" }]);
  });

  it("rejects an unknown Source", async () => {
    const problem = await rejected({ ...berlin, source: "immoscout" });
    expect(problem.errors.map((e) => e.path)).toEqual(["source"]);
  });

  it("rejects a blank city, a missing city and a non-positive price ceiling", async () => {
    expect((await rejected({ ...berlin, city: "   " })).errors[0]?.path).toBe("city");
    expect((await rejected({ categories: ["flat"] })).errors[0]?.path).toBe("city");
    expect((await rejected({ ...berlin, priceCeiling: 0 })).errors[0]?.path).toBe("priceCeiling");
  });

  it("rejects a poll interval that runs backwards or is too fast", async () => {
    const backwards = await rejected({
      ...berlin,
      pollInterval: { minMinutes: 60, maxMinutes: 30 },
    });
    expect(backwards.errors.map((e) => e.path)).toEqual(["pollInterval.maxMinutes"]);
    const fast = await rejected({ ...berlin, pollInterval: { minMinutes: 1, maxMinutes: 5 } });
    expect(fast.errors.map((e) => e.path)).toEqual([
      "pollInterval.minMinutes",
      "pollInterval.maxMinutes",
    ]);
  });

  it("rejects a field it does not know", async () => {
    const problem = await rejected({ ...berlin, recency: 3 });
    expect(problem.errors).toHaveLength(1);
  });

  it("rejects the same bad values when editing, and changes nothing", async () => {
    const { call } = searchesApi();
    const { id } = await (await call("POST", "/searches", berlin)).json();
    const res = await call("PATCH", `/searches/${id}`, { recencyDays: 14, categories: [] });
    expect(res.status).toBe(400);
    const problem = await res.json();
    expect(problem.errors.map((e: FieldError) => e.path).sort()).toEqual([
      "categories",
      "recencyDays",
    ]);
    expect(await (await call("GET", `/searches/${id}`)).json()).toMatchObject({ recencyDays: 7 });
  });

  it("answers malformed JSON with an invalid-body problem", async () => {
    const { runtime } = searchesApi();
    const res = await runtime.app.request("/api/v1/searches", {
      method: "POST",
      headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).type).toBe("invalid-body");
  });
});

describe("editing a Search", () => {
  it("changes only the fields sent and moves updatedAt", async () => {
    const { call } = searchesApi();
    const created = await (
      await call("POST", "/searches", { ...berlin, priceCeiling: 700 })
    ).json();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const res = await call("PATCH", `/searches/${created.id}`, {
      city: "  Potsdam ",
      recencyDays: 3,
      pollInterval: { minMinutes: 20, maxMinutes: 40 },
    });
    expect(res.status).toBe(200);
    const edited = await res.json();
    expect(edited).toEqual({
      ...created,
      city: "Potsdam",
      poll: { nextAt: null, problem: "unknown-city" },
      sweep: { ...created.sweep, status: "idle", mode: null, startAt: null },
      recencyDays: 3,
      pollInterval: { minMinutes: 20, maxMinutes: 40 },
      updatedAt: expect.any(String),
    });
    expect(edited.updatedAt > created.updatedAt).toBe(true);
    expect(edited.createdAt).toBe(created.createdAt);
    expect(await (await call("GET", `/searches/${created.id}`)).json()).toEqual(edited);
  });

  it("clears the price ceiling when sent null", async () => {
    const { call } = searchesApi();
    const { id } = await (await call("POST", "/searches", { ...berlin, priceCeiling: 700 })).json();
    const edited = await (await call("PATCH", `/searches/${id}`, { priceCeiling: null })).json();
    expect(edited.priceCeiling).toBeNull();
  });

  it("disables and re-enables a Search without touching anything else", async () => {
    const { call } = searchesApi();
    const created = await (await call("POST", "/searches", berlin)).json();

    const off = await (await call("PATCH", `/searches/${created.id}`, { enabled: false })).json();
    expect(off).toEqual({
      ...created,
      enabled: false,
      poll: { nextAt: null, problem: null },
      sweep: { ...created.sweep, status: "idle", mode: null, startAt: null },
      updatedAt: expect.any(String),
    });
    const listed = await (await call("GET", "/searches")).json();
    expect(listed.items[0].enabled).toBe(false);

    const on = await (await call("PATCH", `/searches/${created.id}`, { enabled: true })).json();
    expect(on.enabled).toBe(true);
    expect(on.sweep).toMatchObject({ status: "scheduled", mode: "backfill" });
  });

  it("leaves a Search as it is when the edit is empty", async () => {
    const { call } = searchesApi();
    const created = await (await call("POST", "/searches", berlin)).json();
    const res = await call("PATCH", `/searches/${created.id}`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(created);
  });

  it("answers 404 for a Search that does not exist", async () => {
    const { call } = searchesApi();
    const res = await call("PATCH", "/searches/99", { enabled: false });
    expect(res.status).toBe(404);
    expect((await res.json()).type).toBe("not-found");
  });
});

describe("deleting a Search", () => {
  it("removes it from the list and from direct reads", async () => {
    const { call } = searchesApi();
    const keep = await (await call("POST", "/searches", { ...berlin, city: "Köln" })).json();
    const doomed = await (await call("POST", "/searches", berlin)).json();

    const res = await call("DELETE", `/searches/${doomed.id}`);
    expect(res.status).toBe(204);

    expect((await call("GET", `/searches/${doomed.id}`)).status).toBe(404);
    const listed = await (await call("GET", "/searches")).json();
    expect(listed.items).toEqual([keep]);
  });

  it("answers 404 the second time", async () => {
    const { call } = searchesApi();
    const { id } = await (await call("POST", "/searches", berlin)).json();
    await call("DELETE", `/searches/${id}`);
    const again = await call("DELETE", `/searches/${id}`);
    expect(again.status).toBe(404);
    expect((await again.json()).type).toBe("not-found");
  });

  it("answers a validation problem for an id that is not a number", async () => {
    const { call } = searchesApi();
    const res = await call("GET", "/searches/abc");
    expect(res.status).toBe(400);
    expect((await res.json()).type).toBe("validation-error");
  });
});

describe("persistence", () => {
  it("keeps Searches across a restart", async () => {
    const dataDir = tempDataDir();
    const first = searchesApi(bootTestApp(dataDir));
    const created = await (await first.call("POST", "/searches", berlin)).json();
    first.runtime.close();

    const second = searchesApi(bootTestApp(dataDir));
    expect(await (await second.call("GET", `/searches/${created.id}`)).json()).toEqual(created);
  });
});

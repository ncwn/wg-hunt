import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, pageOf } from "./pagination.js";

describe("cursor", () => {
  it("round-trips an opaque cursor", () => {
    const c = encodeCursor({ id: 42 });
    expect(c).not.toContain("42");
    expect(decodeCursor(c)).toEqual({ id: 42 });
  });
  it("returns null for garbage", () => {
    expect(decodeCursor("%%%")).toBeNull();
  });
});

describe("pageOf", () => {
  const rows = [1, 2, 3, 4, 5].map((id) => ({ id }));
  it("takes limit+1 rows and sets nextCursor only when more remain", () => {
    const p = pageOf(rows.slice(0, 3), 2, (r) => ({ id: r.id }));
    expect(p.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(decodeCursor(p.nextCursor ?? "")).toEqual({ id: 2 });
    expect(pageOf(rows.slice(0, 2), 2, (r) => ({ id: r.id })).nextCursor).toBeNull();
  });
});

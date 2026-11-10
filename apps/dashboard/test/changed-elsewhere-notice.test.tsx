// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { choose } from "./choose.js";
import { openProfile, preview } from "./profile-harness.js";

// React may run a state updater when it next renders rather than when it is set, so nothing the
// page decides may depend on the updater having run already. Here every change to the held draft
// waits a turn, as it can in React, to show the page doesn't rely on it.
vi.mock(import("../src/draft.js"), async (original) => {
  const draft = await original();
  type SetHeld = ReturnType<typeof draft.useSeekingDraft>["setHeld"];
  // One deferred setter per real one, so it is as stable as React's.
  const deferred = new WeakMap<SetHeld, SetHeld>();
  const defer = (setHeld: SetHeld): SetHeld => {
    let later = deferred.get(setHeld);
    if (!later) {
      later = (update) => queueMicrotask(() => setHeld(update));
      deferred.set(setHeld, later);
    }
    return later;
  };
  return {
    ...draft,
    useSeekingDraft: () => {
      const real = draft.useSeekingDraft();
      return { ...real, setHeld: defer(real.setHeld) };
    },
  };
});

describe("Profile & Filters: the notice that a draft was laid over a newer copy", () => {
  it("says so on return even when the draft is updated after the read is handled", async () => {
    const { user, server } = await openProfile();
    await choose(user, screen.getByLabelText("Diet"), "Vegan");
    await within(preview()).findByText(/would be ranked differently/);

    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    await user.click(nav.getByRole("link", { name: /Searches/ }));
    await screen.findByRole("heading", { level: 1, name: "Searches" });
    const filters = await (await server.asCli("/filters")).json();
    filters.hideLikelyScams.enabled = true;
    const res = await server.asCli("/filters", { method: "PUT", body: JSON.stringify(filters) });
    expect(res.status).toBe(200);

    await user.click(nav.getByRole("link", { name: /Profile$/ }));
    await screen.findByRole("heading", { level: 2, name: "About you" });
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();
  });
});

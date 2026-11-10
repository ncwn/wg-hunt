// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openProfile, preview, saved } from "./profile-harness.js";

const rentLimit = () => screen.getByLabelText("Max warm rent limit") as HTMLInputElement;
const loadExample = () => screen.getByRole("button", { name: "Load example" });
const confirmation = () => screen.queryByText(/Replace your unsaved changes with the example\?/);
const presetRequests = (requested: string[]) =>
  requested.filter((path) => path === "/presets/example").length;

async function withDraft() {
  const opened = await openProfile();
  await opened.user.type(rentLimit(), "480");
  await within(preview()).findByText(/2 Offers would be ranked differently/);
  return opened;
}

describe("Profile & Filters page: loading the example over an unsaved draft", () => {
  it("asks first, and fetches nothing until asked", async () => {
    const { user, requested } = await withDraft();
    await user.click(loadExample());

    expect(confirmation()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(presetRequests(requested)).toBe(0);
    expect(rentLimit().value).toBe("480");
  });

  it("keeps the draft, its dot and its preview on Cancel", async () => {
    const { user, requested } = await withDraft();
    await user.click(loadExample());
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(confirmation()).toBeNull();
    expect(rentLimit().value).toBe("480");
    expect(within(preview()).getByText(/2 Offers would be ranked differently/)).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("img", {
        name: "Unsaved draft",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Example loaded as a draft/)).toBeNull();
    expect(presetRequests(requested)).toBe(0);
  });

  it("loads the example as a draft on Replace, and saves nothing", async () => {
    const { user, server } = await withDraft();
    await user.click(loadExample());
    await user.click(screen.getByRole("button", { name: "Replace" }));

    expect(await screen.findByText(/Example loaded as a draft/)).toBeTruthy();
    expect(confirmation()).toBeNull();
    expect(rentLimit().value).toBe("700");
    expect((screen.getByLabelText("Age") as HTMLInputElement).value).toBe("27");
    expect((await saved(server, "filters")).maxRent.limit).toBeNull();
  });

  it("still asks about a draft left for another page and come back to", async () => {
    const { user, requested } = await withDraft();
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    await user.click(nav.getByRole("link", { name: /Searches/ }));
    await screen.findByRole("heading", { level: 1, name: "Searches" });
    await user.click(nav.getByRole("link", { name: /Profile$/ }));
    await screen.findByRole("heading", { level: 2, name: "About you" });

    await user.click(loadExample());
    expect(confirmation()).toBeTruthy();
    expect(presetRequests(requested)).toBe(0);
    expect(rentLimit().value).toBe("480");
  });

  it("is announced, works from the keyboard, and gives focus back to Load example", async () => {
    const { user } = await withDraft();
    loadExample().focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("alertdialog").textContent).toMatch(/Replace your unsaved changes/);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard(" ");
    expect(confirmation()).toBeNull();
    expect(document.activeElement).toBe(loadExample());
    expect(rentLimit().value).toBe("480");

    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/Example loaded as a draft/)).toBeTruthy();
    expect(document.activeElement).toBe(loadExample());
  });

  it("keeps the draft when the example fails to load after Replace", async () => {
    const { user, breakPreset } = await withDraft();
    breakPreset();
    await user.click(loadExample());
    await user.click(screen.getByRole("button", { name: "Replace" }));

    const alert = await within(preview()).findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't load the example: the preset broke/);
    expect(confirmation()).toBeNull();
    expect(rentLimit().value).toBe("480");
    expect(screen.queryByText(/Example loaded as a draft/)).toBeNull();
  });
});

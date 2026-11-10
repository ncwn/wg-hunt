// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { choose } from "./choose.js";
import { cardsMarked, discard, openProfile, preview, previewed, saved } from "./profile-harness.js";

describe("Profile & Filters page: the draft preview", () => {
  it("has no preview panel before there is a draft", async () => {
    await openProfile();
    expect(screen.queryByRole("complementary", { name: "Draft preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Unsaved draft" })).toBeNull();
  });

  it("shows which Offers would be ranked differently while a Filter is edited, and saves nothing", async () => {
    const { user, server } = await openProfile();
    await user.type(screen.getByLabelText("Max warm rent limit"), "480");

    const panel = within(preview());
    expect(await previewed(/2 Offers would be ranked differently/)).toBeTruthy();
    const dear = (await panel.findByText("Dear")).closest("li");
    expect(dear?.textContent).toMatch(/Match.*Near match/);
    expect(panel.getByText("Dearest").closest("li")?.textContent).toMatch(/Match.*Hidden/);
    expect(panel.queryByText("Cheap")).toBeNull();

    expect((await saved(server, "filters")).maxRent.limit).toBeNull();
    const offers = await (await server.call("GET", "/offers")).json();
    expect(offers.items.map((o: { band: string }) => o.band)).toEqual(["match", "match", "match"]);
  });

  it("marks the draft in the accent style and in the nav rail", async () => {
    const { user } = await openProfile();
    await user.type(screen.getByLabelText("Max warm rent limit"), "480");
    await previewed();

    expect(cardsMarked()).toBe(true);
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    expect(nav.getByRole("img", { name: "Unsaved draft" })).toBeTruthy();
  });

  it("asks before Discard, and Cancel keeps the draft", async () => {
    const { user } = await openProfile();
    const limit = screen.getByLabelText("Max warm rent limit") as HTMLInputElement;
    await user.type(limit, "480");
    await previewed();

    await user.click(within(preview()).getByRole("button", { name: "Discard" }));
    const question = screen.getByRole("alertdialog", { name: "Discard your unsaved changes?" });
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(limit.value).toBe("480");
    expect(preview()).toBeTruthy();
  });

  it("restores the saved state on Discard, and the panel goes", async () => {
    const { user, server } = await openProfile();
    const limit = screen.getByLabelText("Max warm rent limit") as HTMLInputElement;
    await user.type(limit, "480");
    await previewed();

    await discard(user);
    await waitFor(() => expect(limit.value).toBe(""));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Draft preview" })).toBeNull(),
    );
    expect(screen.queryByRole("img", { name: "Unsaved draft" })).toBeNull();
    expect((await saved(server, "filters")).maxRent.limit).toBeNull();
  });

  it("saves the Profile and Filters on Save, re-bands the Offers and clears the draft", async () => {
    const { user, server } = await openProfile();
    await user.type(screen.getByLabelText("Max warm rent limit"), "480");
    await choose(user, screen.getByLabelText("Diet"), "Vegan");
    const panel = within(preview());
    await previewed(/2 Offers would be ranked differently/);

    await user.click(panel.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();

    expect((await saved(server, "filters")).maxRent.limit).toBe(480);
    expect(await saved(server, "profile")).toMatchObject({ diet: "vegan" });
    const offers = await (await server.call("GET", "/offers?includeHidden=true")).json();
    expect(
      Object.fromEntries(
        offers.items.map((o: { title: string; band: string }) => [o.title, o.band]),
      ),
    ).toEqual({
      Cheap: "match",
      Dear: "near-match",
      Dearest: "hidden",
    });
    expect(screen.queryByRole("img", { name: "Unsaved draft" })).toBeNull();
    expect((screen.getByLabelText("Max warm rent limit") as HTMLInputElement).value).toBe("480");
  });

  it("previews a Want and a margin: a Want only moves Offers to Near match", async () => {
    const { user } = await openProfile();
    await user.type(screen.getByLabelText("Max warm rent limit"), "480");
    await user.click(
      within(screen.getByRole("group", { name: "Max warm rent: how strict" })).getByRole("button", {
        name: "Near match",
      }),
    );
    const panel = within(preview());
    await waitFor(() => {
      expect(panel.getByText("Dearest").closest("li")?.textContent).toMatch(/Match.*Near match/);
    });

    await user.click(
      within(screen.getByRole("group", { name: "Max warm rent: how strict" })).getByRole("button", {
        name: "Hide it",
      }),
    );
    await user.clear(screen.getByLabelText("Max warm rent margin"));
    await waitFor(() => {
      expect(panel.getByText("Dear").closest("li")?.textContent).toMatch(/Match.*Hidden/);
    });
    expect(panel.getByText("Dearest").closest("li")?.textContent).toMatch(/Match.*Hidden/);
  });

  it("keeps a draft while the seeker visits another page", async () => {
    const { user } = await openProfile();
    await user.type(screen.getByLabelText("Max warm rent limit"), "480");
    await previewed();

    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    await user.click(nav.getByRole("link", { name: /Searches/ }));
    await screen.findByRole("heading", { level: 1, name: "Searches" });
    expect(nav.getByRole("img", { name: "Unsaved draft" })).toBeTruthy();

    await user.click(nav.getByRole("link", { name: /Profile$/ }));
    const limit = (await screen.findByLabelText("Max warm rent limit")) as HTMLInputElement;
    expect(limit.value).toBe("480");
    expect(await previewed(/2 Offers would be ranked differently/)).toBeTruthy();
  });
});

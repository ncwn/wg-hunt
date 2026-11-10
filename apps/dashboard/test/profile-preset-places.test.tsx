// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { choose } from "./choose.js";
import { cardsMarked, discard, openProfile, preview, previewed, saved } from "./profile-harness.js";

const input = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const saveButton = () => within(preview()).getByRole("button", { name: "Save" });
const switchOn = (name: string) =>
  screen.getByRole("checkbox", { name }).getAttribute("aria-checked") === "true";
const held = (name: string) => screen.getByLabelText(name).getAttribute("data-value");
const savable = () => waitFor(() => expect(saveButton()).toHaveProperty("disabled", false));

describe("Profile & Filters page: the example preset", () => {
  it("loads as a draft and saves nothing until Save", async () => {
    const { user, server } = await openProfile([]);
    await user.click(screen.getByRole("button", { name: "Load example" }));

    expect(await screen.findByText(/Example loaded as a draft/)).toBeTruthy();
    expect(input("Age").value).toBe("27");
    expect(input("Max warm rent limit").value).toBe("700");
    expect(input("Min size limit").value).toBe("12");
    expect(input("Distance to a Place limit").value).toBe("5");
    expect(input("Place 1 name").value).toBe("work");
    expect(input("Place 1 PLZ").value).toBe("10115");
    expect(input("Languages spoken").value).toBe("de, en");
    expect(cardsMarked()).toBe(true);
    expect(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("img", {
        name: "Unsaved draft",
      }),
    ).toBeTruthy();

    await previewed();
    expect((await saved(server, "profile")).age).toBeNull();
    expect((await saved(server, "filters")).maxRent.limit).toBeNull();
    expect((await (await server.call("GET", "/searches")).json()).items).toEqual([]);
  });

  it("puts the move-in window in the month two months after loading", async () => {
    const { user } = await openProfile();
    await user.click(screen.getByRole("button", { name: "Load example" }));
    await waitFor(() => expect(held("Move in from")).toBe("2027-01-01"));
    expect(held("Move in by")).toBe("2027-01-15");
  });

  it("is saved with Save, and thrown away with Discard", async () => {
    const { user, server } = await openProfile();
    await user.click(screen.getByRole("button", { name: "Load example" }));
    await previewed();
    await discard(user);
    await waitFor(() => expect(input("Age").value).toBe(""));
    expect((await saved(server, "profile")).places).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Load example" }));
    await previewed();
    await savable();
    await user.click(saveButton());
    expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();

    expect(await saved(server, "profile")).toMatchObject({
      age: 27,
      diet: "vegetarian",
      places: [{ name: "work", plz: "10115" }],
    });
    expect((await saved(server, "filters")).distance).toMatchObject({ place: "work", limit: 5 });
  });

  it("offers its Search on the Searches page as a draft, and creates nothing itself", async () => {
    const { user, server } = await openProfile([]);
    await user.click(screen.getByRole("button", { name: "Load example" }));
    await user.click(await screen.findByRole("button", { name: "Review it in Searches" }));

    await screen.findByRole("heading", { level: 1, name: "Searches" });
    expect(await screen.findByRole("heading", { name: "New search" })).toBeTruthy();
    expect(input("City").value).toBe("Berlin");
    expect(switchOn("Flatshare room")).toBe(true);
    expect(switchOn("1-room flat")).toBe(true);
    expect(switchOn("Flat")).toBe(false);
    await user.click(screen.getByRole("button", { name: /More options/ }));
    expect(switchOn("Unlimited")).toBe(true);
    expect(switchOn("Limited")).toBe(false);
    expect(input("Most you'll pay, warm").value).toBe("800");
    expect(held("How recent should ads be?")).toBe("7");
    expect((await (await server.call("GET", "/searches")).json()).items).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("article", { name: /in Berlin/ });
    expect((await (await server.call("GET", "/searches")).json()).items).toMatchObject([
      { city: "Berlin", rentTypes: ["unlimited"], priceCeiling: 800, recencyDays: 7 },
    ]);
  });
});

describe("the example preset's Search, once saved", () => {
  it("is not offered again by Back and Forward, so it can't be made twice", async () => {
    const { user, back, location } = await openProfile([]);
    await user.click(screen.getByRole("button", { name: "Load example" }));
    await user.click(await screen.findByRole("button", { name: "Review it in Searches" }));
    await screen.findByRole("heading", { name: "New search" });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("article", { name: /in Berlin/ });

    // The router moves in a transition, so the card can show before the spent suggestion is gone.
    await waitFor(() =>
      expect((location().state as { draftSearch?: unknown } | null)?.draftSearch).toBeUndefined(),
    );
    await back();
    await screen.findByRole("heading", { level: 1, name: "Profile & Filters" });
    await user.click(await screen.findByRole("link", { name: "Searches" }));
    await screen.findByRole("article", { name: /in Berlin/ });
    expect(screen.queryByRole("heading", { name: "New search" })).toBeNull();
  });
});

describe("Profile & Filters page: Places and the distance Filter", () => {
  async function addWork(user: Awaited<ReturnType<typeof openProfile>>["user"]) {
    await user.click(screen.getByRole("button", { name: "Add a place" }));
    await user.type(input("Place 1 name"), "work");
    await user.type(input("Place 1 PLZ"), "10115");
  }

  const writes = (written: string[]) => written.filter((w) => w !== "POST /ranking/preview");

  async function saveWorkWithin5(opened: Awaited<ReturnType<typeof openProfile>>) {
    const { user } = opened;
    await addWork(user);
    await user.click(screen.getByRole("switch", { name: "Distance to a Place" }));
    await choose(user, screen.getByLabelText("Distance to a Place: which Place"), "work");
    await user.type(input("Distance to a Place limit"), "5");

    await savable();
    await user.click(saveButton());
    expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();
  }

  it("adds a Place, measures a Filter from it, and saves both together", async () => {
    const opened = await openProfile();
    const { server, written } = opened;
    await saveWorkWithin5(opened);
    expect(writes(written)).toEqual(["PUT /seeking"]);

    expect((await saved(server, "profile")).places).toEqual([{ name: "work", plz: "10115" }]);
    expect((await saved(server, "filters")).distance).toMatchObject({
      enabled: true,
      place: "work",
      limit: 5,
    });
  });

  it("renames a Place the Filter measures from in one request", async () => {
    const opened = await openProfile();
    const { user, server, written } = opened;
    await saveWorkWithin5(opened);
    await user.type(input("Place 1 name"), "s");
    await savable();
    await user.click(saveButton());
    await waitFor(() => expect(writes(written)).toEqual(["PUT /seeking", "PUT /seeking"]));
    await waitFor(async () =>
      expect((await saved(server, "profile")).places).toEqual([{ name: "works", plz: "10115" }]),
    );
    expect((await saved(server, "filters")).distance.place).toBe("works");
  });

  it("follows a renamed Place and lets go of a removed one", async () => {
    const { user } = await openProfile();
    await addWork(user);
    await user.click(screen.getByRole("switch", { name: "Distance to a Place" }));
    const which = screen.getByLabelText("Distance to a Place: which Place");
    await choose(user, which, "work");

    await user.type(input("Place 1 name"), "s");
    await waitFor(() => expect(which.getAttribute("data-value")).toBe("works"));

    await user.click(screen.getByRole("button", { name: "Remove Place 1" }));
    await waitFor(() => expect(which.getAttribute("data-value")).toBe(""));
  });

  it("says why a draft can't be previewed, and won't Save it", async () => {
    const { user, server } = await openProfile();
    await user.click(screen.getByRole("button", { name: "Add a place" }));
    await user.type(input("Place 1 name"), "work");

    const alert = await within(preview()).findByRole("alert");
    expect(alert.textContent).toMatch(/can't be previewed/);
    expect(alert.textContent).toMatch(/Place 1 PLZ/);
    expect(saveButton()).toHaveProperty("disabled", true);

    await user.type(input("Place 1 PLZ"), "10115");
    await previewed();
    expect(saveButton()).toHaveProperty("disabled", false);
    expect((await saved(server, "profile")).places).toEqual([]);
  });

  it("offers Try again when a preview didn't get through, and Saves once it does", async () => {
    const { user, failPreview } = await openProfile();
    failPreview(true);
    await user.type(input("Max warm rent limit"), "480");

    const alert = await within(preview()).findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't work out what changes/);
    expect(saveButton()).toHaveProperty("disabled", true);

    failPreview(false);
    await user.click(within(preview()).getByRole("button", { name: "Try again" }));
    await previewed(/2 Offers/);
    expect(within(preview()).queryByRole("alert")).toBeNull();
    await savable();
  });

  it("takes pasted coordinates instead of a PLZ", async () => {
    const { user } = await openProfile();
    await user.click(screen.getByRole("button", { name: "Add a place" }));
    await user.type(input("Place 1 name"), "gym");
    const locatedBy = within(screen.getByRole("group", { name: "Place 1 located by" }));
    await user.click(locatedBy.getByRole("button", { name: "Coordinates" }));
    await user.type(input("Place 1 latitude"), "52.52");
    await user.type(input("Place 1 longitude"), "13.405");
    await previewed();
    await savable();
  });
});

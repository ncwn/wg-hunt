// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeServer } from "./fake-server.js";
import { renderDashboard } from "./render.js";

const NAV_ENTRIES = ["Overview", "Offers", "Searches", "Profile", "Settings"];

describe("login", () => {
  it("shows the login screen to an unauthenticated visitor, without the nav", async () => {
    renderDashboard(fakeServer().fetch);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByLabelText("Access token")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("goes straight to the dashboard when the session cookie is still valid", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch);
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  });

  it("signs in with the correct token", async () => {
    const server = fakeServer({ token: "correct-token" });
    const { user } = renderDashboard(server.fetch);
    await user.type(await screen.findByLabelText("Access token"), "correct-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(server.state.signedIn).toBe(true);
  });

  it("signs in when the token is submitted with Enter", async () => {
    const { user } = renderDashboard(fakeServer({ token: "correct-token" }).fetch);
    await user.type(await screen.findByLabelText("Access token"), "correct-token{Enter}");
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  it("says so when the token is wrong, and stays on the login screen", async () => {
    const { user } = renderDashboard(fakeServer().fetch);
    await user.type(await screen.findByLabelText("Access token"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/isn.t right|not accepted|wrong/i);
    expect(screen.queryByRole("navigation")).toBeNull();
    const field = screen.getByLabelText("Access token");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.parentElement?.id);
    expect(screen.getByText(/access-token file of its data folder/)).toBeTruthy();
  });

  it("does not send an empty token", async () => {
    const server = fakeServer();
    const { user } = renderDashboard(server.fetch);
    await screen.findByLabelText("Access token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(server.state.requests).not.toContain("POST /api/v1/auth/session");
  });

  it("reports an unreachable server instead of pretending the token was wrong", async () => {
    const server = fakeServer();
    const { user } = renderDashboard(async (request) => {
      if (request.method === "POST") throw new TypeError("fetch failed");
      return server.fetch(request);
    });
    await user.type(await screen.findByLabelText("Access token"), "anything");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/reach/i);
  });
});

describe("nav rail", () => {
  it("lists Overview, Offers, Searches and Profile, with Settings at the foot", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const labels = Array.from(nav.querySelectorAll("a")).map((a) => a.textContent?.trim());
    expect(labels).toEqual(NAV_ENTRIES);
  });

  it("opens the Overview at / and marks the current entry", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("opens the page behind each entry", async () => {
    const { user } = renderDashboard(fakeServer({ signedIn: true }).fetch);
    for (const [entry, title] of [
      ["Offers", "Offers"],
      ["Searches", "Searches"],
      ["Profile", "Profile & Filters"],
      ["Settings", "Settings"],
      ["Overview", "Overview"],
    ] as const) {
      await user.click(await screen.findByRole("link", { name: entry }));
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
      expect(screen.getByRole("link", { name: entry }).getAttribute("aria-current")).toBe("page");
    }
  });

  it("shows the hunt's status in the top bar of every page", async () => {
    const { user } = renderDashboard(fakeServer({ signedIn: true }).fetch);
    const header = async () => within(await screen.findByRole("banner"));
    expect(await (await header()).findByText("Hunting")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Searches" }));
    expect(await (await header()).findByText("Hunting")).toBeTruthy();
  });

  it("opens a deep link such as /searches directly", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch, "/searches");
    expect(await screen.findByRole("heading", { level: 1, name: "Searches" })).toBeTruthy();
  });

  it("still opens one band of the Offers at /offers/<band>", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch, "/offers/near-match");
    expect(await screen.findByRole("heading", { level: 1, name: "Offers" })).toBeTruthy();
  });

  it("has no Shortlist page any more", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch, "/shortlist");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Shortlist" })).toBeNull();
  });

  it("shows a not-found page for an unknown route, inside the shell", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch, "/nope");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
  });
});

describe("page frame", () => {
  it("puts every page's top bar at the top of the sheet, before the page", async () => {
    const { user } = renderDashboard(fakeServer({ signedIn: true }).fetch);
    for (const entry of ["Overview", "Searches", "Profile", "Settings"]) {
      await user.click((await screen.findAllByRole("link", { name: entry }))[0] as HTMLElement);
      const main = screen.getByRole("main");
      const head = main.firstElementChild as HTMLElement;
      expect(head.className, entry).toBe("sheet-head");
      expect(within(head).getByRole("heading", { level: 1 })).toBeTruthy();
      expect(main.querySelector(".sheet-body .wh-topbar"), entry).toBeNull();
    }
  });
});

describe("sign out", () => {
  it("is in Settings, not in the navigation", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch, "/settings");
    const settings = await screen.findByRole("region", { name: "This browser" });
    expect(within(settings).getByRole("button", { name: "Sign out" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("asks first, and Cancel keeps the session", async () => {
    const server = fakeServer({ signedIn: true });
    const { user } = renderDashboard(server.fetch, "/settings");
    const button = await screen.findByRole("button", { name: "Sign out" });
    await user.click(button);
    const question = screen.getByRole("alertdialog", { name: "Sign out of wg-hunt?" });
    expect(question.getAttribute("aria-modal")).toBe("true");
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(server.state.signedIn).toBe(true);
    expect(server.state.requests).not.toContain("DELETE /api/v1/auth/session");
  });

  it("closes the question on Escape", async () => {
    const { user } = renderDashboard(fakeServer({ signedIn: true }).fetch, "/settings");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
  });

  it("ends the session and returns to the login screen once confirmed", async () => {
    const server = fakeServer({ signedIn: true });
    const { user } = renderDashboard(server.fetch, "/settings");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    const question = screen.getByRole("alertdialog", { name: "Sign out of wg-hunt?" });
    await user.click(within(question).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(server.state.signedIn).toBe(false);
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("keyboard", () => {
  it("reaches the skip link and every nav entry with Tab, in reading order", async () => {
    const { user } = renderDashboard(fakeServer({ signedIn: true }).fetch);
    await screen.findByRole("navigation", { name: "Main" });
    const visited: string[] = [];
    for (let i = 0; i < NAV_ENTRIES.length + 1; i++) {
      await user.tab();
      visited.push(document.activeElement?.textContent?.trim() ?? "");
    }
    expect(visited).toEqual(["Skip to content", ...NAV_ENTRIES]);
  });

  it("lets the skip link jump to the main content", async () => {
    const { user } = renderDashboard(fakeServer({ signedIn: true }).fetch);
    await screen.findByRole("navigation", { name: "Main" });
    await user.tab();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("puts the token field first on the login screen", async () => {
    const { user } = renderDashboard(fakeServer().fetch);
    const field = await screen.findByLabelText("Access token");
    await user.tab();
    expect(document.activeElement).toBe(field);
  });
});

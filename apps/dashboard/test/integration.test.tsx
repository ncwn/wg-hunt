// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

describe("dashboard against the real server", () => {
  it("rejects a wrong token, accepts the real one and signs out again", async () => {
    const server = realServer();
    const { user } = renderDashboard(server.fetch);

    await user.type(await screen.findByLabelText("Access token"), "not-the-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn.t right/);

    await user.clear(screen.getByLabelText("Access token"));
    await user.type(screen.getByLabelText("Access token"), server.token);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    const question = screen.getByRole("alertdialog", { name: "Sign out of wg-hunt?" });
    await user.click(within(question).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("shows the real hunting status on the Overview, and Pause and Resume work end to end", async () => {
    const server = realServer();
    const { user } = renderDashboard(server.fetch);
    await user.type(await screen.findByLabelText("Access token"), server.token);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const card = within(await screen.findByRole("region", { name: "Hunting status" }));
    expect(
      (await card.findByRole("heading", { name: /Hunting is on|Resting for the night/ }))
        .textContent,
    ).toBeTruthy();

    await user.click(card.getByRole("button", { name: "Pause" }));
    expect(await card.findByRole("heading", { name: "Hunting is paused" })).toBeTruthy();
    await user.click(await card.findByRole("button", { name: "Resume" }));
    expect(
      await card.findByRole("heading", { name: /Hunting is on|Resting for the night/ }),
    ).toBeTruthy();
  });

  it("keeps the session across a reload", async () => {
    const server = realServer();
    const first = renderDashboard(server.fetch);
    await first.user.type(await screen.findByLabelText("Access token"), server.token);
    await first.user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("navigation", { name: "Main" });

    cleanup(); // a reload: the page is gone, the cookie stays
    renderDashboard(server.fetch);
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
  });
});

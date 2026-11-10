// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeServer } from "./fake-server.js";
import { openProfile, preview } from "./profile-harness.js";
import { fakeEventStream, renderDashboard } from "./render.js";

const unauthorized = () =>
  new Response(JSON.stringify({ type: "unauthorized", title: "Unauthorized", status: 401 }), {
    status: 401,
    headers: { "Content-Type": "application/problem+json" },
  });

function guardedServer() {
  const server = fakeServer({ signedIn: true });
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (!server.state.signedIn && !path.endsWith("/auth/session")) return unauthorized();
    return server.fetch(request);
  };
  return { ...server, fetch };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const signInAgain = () => screen.getByRole("dialog", { name: "Sign in again" });

async function signInThroughDialog(
  user: {
    type: (el: Element, text: string) => Promise<void>;
    click: (el: Element) => Promise<void>;
  },
  token = "correct-token",
) {
  const dialog = within(await screen.findByRole("dialog", { name: "Sign in again" }));
  await user.type(dialog.getByLabelText("Access token"), token);
  await user.click(dialog.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sign in again" })).toBeNull());
}

describe("the session check at boot", () => {
  it("says wg-hunt can't be reached instead of asking for the token, and gets in on Try again", async () => {
    const server = fakeServer({ signedIn: true });
    let down = true;
    const { user } = renderDashboard(
      async (request) => {
        if (down) throw new TypeError("fetch failed");
        return server.fetch(request);
      },
      "/",
      undefined,
      { retryMs: 60_000 },
    );
    expect(await screen.findByRole("heading", { name: "Can't reach wg-hunt" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();

    down = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  it("counts a proxy's 502 during a restart as unreachable, not as signed out", async () => {
    const server = fakeServer({ signedIn: true });
    renderDashboard(
      async (request) =>
        new URL(request.url).pathname.endsWith("/auth/session")
          ? new Response("Bad Gateway", { status: 502 })
          : server.fetch(request),
      "/",
      undefined,
      { retryMs: 60_000 },
    );
    expect(await screen.findByRole("heading", { name: "Can't reach wg-hunt" })).toBeTruthy();
    expect(screen.queryByLabelText("Access token")).toBeNull();
  });

  it("stops waiting for an answer that doesn't come", async () => {
    renderDashboard(() => new Promise<Response>(() => {}), "/", undefined, {
      checkTimeoutMs: 20,
      retryMs: 60_000,
    });
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(await screen.findByRole("heading", { name: "Can't reach wg-hunt" })).toBeTruthy();
  });

  it("asks again by itself, so a server that restarts ends on the dashboard", async () => {
    const server = fakeServer({ signedIn: true });
    let checks = 0;
    renderDashboard(
      async (request) => {
        if (new URL(request.url).pathname.endsWith("/auth/session") && ++checks === 1) {
          throw new TypeError("fetch failed");
        }
        return server.fetch(request);
      },
      "/",
      undefined,
      { retryMs: 10 },
    );
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(checks).toBe(2);
  });

  it("still shows the sign-in when the server says there is no session", async () => {
    renderDashboard(fakeServer().fetch);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });
});

describe("a session that ends under the pages", () => {
  it("keeps the unsaved Profile draft behind a sign-in when an agent rotates the token", async () => {
    const { user, server } = await openProfile();
    const limit = screen.getByLabelText("Max warm rent limit") as HTMLInputElement;
    await user.type(limit, "480");
    await within(preview()).findByText(/would be ranked differently/);

    const rotated = await server.asCli("/auth/token/rotate", { method: "POST" });
    expect(rotated.status).toBe(200);
    await user.type(limit, "0");

    const dialog = within(await screen.findByRole("dialog", { name: "Sign in again" }));
    expect(dialog.getByText(/Anything you haven't saved is still here/)).toBeTruthy();
    expect(limit.isConnected).toBe(true);
    expect(limit.value).toBe("4800");

    await signInThroughDialog(user, server.token);
    expect((screen.getByLabelText("Max warm rent limit") as HTMLInputElement).value).toBe("4800");
    await within(preview()).findByText(/would be ranked differently/);
    await user.click(within(preview()).getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect((await (await server.call("GET", "/filters")).json()).maxRent.limit).toBe(4800),
    );
  });

  it("goes to the sign-in for signed-out and expired, saying why, and does not reconnect", async () => {
    for (const [reason, why] of [
      ["signed-out", /signed out, perhaps from another tab/],
      ["expired", /ended after a long time unused/],
    ] as const) {
      const server = guardedServer();
      const events = fakeEventStream();
      const { unmount } = renderDashboard(server.fetch, "/", events.stream);
      await screen.findByRole("navigation", { name: "Main" });

      server.state.signedIn = false;
      await events.endSession(reason);

      expect(within(signInAgain()).getByText(why)).toBeTruthy();
      expect(events.reopened()).toBe(0);
      unmount();
    }
  });

  it("stays signed in after a rotation from this tab, and opens a fresh stream", async () => {
    const server = guardedServer();
    const events = fakeEventStream();
    renderDashboard(server.fetch, "/", events.stream);
    await screen.findByRole("navigation", { name: "Main" });

    await events.endSession("token-rotated");

    await waitFor(() => expect(events.reopened()).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.state.requests).toContain("GET /api/v1/auth/session");
  });

  it("asks for the new token after a rotation from elsewhere", async () => {
    const server = guardedServer();
    const events = fakeEventStream();
    renderDashboard(server.fetch, "/", events.stream);
    await screen.findByRole("navigation", { name: "Main" });

    server.state.signedIn = false;
    await events.endSession("token-rotated");

    expect(
      within(await screen.findByRole("dialog", { name: "Sign in again" })).getByText(
        /access token was replaced/,
      ),
    ).toBeTruthy();
    expect(events.reopened()).toBe(0);
    expect(events.state()).toEqual({ status: "ended", reason: "token-rotated" });
  });

  it("reopens the stream after signing in again, and every page reads again", async () => {
    const server = guardedServer();
    const events = fakeEventStream();
    const { user } = renderDashboard(server.fetch, "/", events.stream);
    await screen.findByRole("navigation", { name: "Main" });
    server.state.signedIn = false;
    await events.endSession("expired");

    const before = server.state.requests.filter((r) => r === "GET /api/v1/crawl").length;
    await signInThroughDialog(user);

    expect(events.reopened()).toBe(1);
    await waitFor(() =>
      expect(server.state.requests.filter((r) => r === "GET /api/v1/crawl").length).toBe(
        before + 1,
      ),
    );
  });

  it("is not signed out again by a refusal that was sent before signing in again", async () => {
    const server = guardedServer();
    const events = fakeEventStream();
    let release: (() => void) | undefined;
    let hold = false;
    const fetch = async (request: Request) => {
      const answer = await server.fetch(request);
      if (hold && new URL(request.url).pathname === "/api/v1/crawl") {
        hold = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return answer;
    };
    const { user } = renderDashboard(fetch, "/", events.stream);
    await screen.findByRole("navigation", { name: "Main" });
    server.state.signedIn = false;
    await events.endSession("expired");

    hold = true;
    await events.reconnect();
    await waitFor(() => expect(release).toBeDefined());

    await signInThroughDialog(user);
    release?.();
    await settle();

    expect(screen.queryByRole("dialog", { name: "Sign in again" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  it("puts an open question aside while the session is lost, and asks it again after", async () => {
    const server = guardedServer();
    const events = fakeEventStream();
    const { user } = renderDashboard(server.fetch, "/settings", events.stream);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    const question = screen.getByRole("alertdialog", { name: "Sign out of wg-hunt?" });

    server.state.signedIn = false;
    await events.endSession("expired");

    const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const field = within(dialog).getByLabelText("Access token");
    expect(document.activeElement).toBe(field);
    await user.keyboard("{Tab}");
    expect(question.contains(document.activeElement)).toBe(false);
    await user.keyboard("{Escape}");

    field.focus();
    await signInThroughDialog(user);
    const back = screen.getByRole("alertdialog", { name: "Sign out of wg-hunt?" });
    expect(back.contains(document.activeElement)).toBe(true);
    await user.click(within(back).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(server.state.requests).not.toContain("DELETE /api/v1/auth/session");
  });

  it("still signs out to the plain sign-in screen when the seeker asks", async () => {
    const server = guardedServer();
    const events = fakeEventStream();
    const held: { release?: () => void } = {};
    const fetch = async (request: Request) => {
      if (request.method === "DELETE") {
        await new Promise<void>((resolve) => {
          held.release = resolve;
        });
      }
      return server.fetch(request);
    };
    const { user } = renderDashboard(fetch, "/settings", events.stream);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    const question = screen.getByRole("alertdialog", { name: "Sign out of wg-hunt?" });
    await user.click(within(question).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(held.release).toBeDefined());

    await events.endSession("signed-out");
    expect(screen.queryByRole("dialog", { name: "Sign in again" })).toBeNull();
    held.release?.();

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("live updates", () => {
  it("say they are paused when the stream fails, with a Retry that reopens it", async () => {
    const server = guardedServer();
    const events = fakeEventStream();
    const { user } = renderDashboard(server.fetch, "/", events.stream);
    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByText(/Live updates paused/)).toBeNull();

    await events.become({ status: "failed", retryAt: Date.now() + 5_000 });

    expect(screen.getByText(/Live updates paused: wg-hunt didn't answer/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry now" }));
    expect(events.reopened()).toBe(1);
    expect(screen.queryByText(/Live updates paused/)).toBeNull();
  });

  it("say so while the browser reconnects", async () => {
    const events = fakeEventStream();
    renderDashboard(guardedServer().fetch, "/", events.stream);
    await screen.findByRole("navigation", { name: "Main" });

    await events.become({ status: "reconnecting" });
    expect(screen.getByText(/Live updates paused: the connection to wg-hunt dropped/)).toBeTruthy();
    await events.become({ status: "live" });
    expect(screen.queryByText(/Live updates paused/)).toBeNull();
  });

  it("find out that the session ended when the stream fails with a 401", async () => {
    const server = guardedServer();
    const events = fakeEventStream();
    renderDashboard(server.fetch, "/", events.stream);
    await screen.findByRole("navigation", { name: "Main" });

    server.state.signedIn = false;
    await events.become({ status: "failed", retryAt: Date.now() + 5_000 });

    expect(await screen.findByRole("dialog", { name: "Sign in again" })).toBeTruthy();
    expect(events.state()).toEqual({ status: "ended", reason: "unauthorized" });
  });
});

// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UNREACHABLE } from "../src/api/result.js";
import { openAdvanced, openFold } from "./advanced.js";
import { choose } from "./choose.js";
import { fakeServer } from "./fake-server.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

const SERVER_TROUBLE = "wg-hunt ran into a problem. Try again in a moment.";
// The page a proxy in front of wg-hunt answers with when wg-hunt is down: no problem body.
const badGateway = () => new Response("<html>Bad Gateway</html>", { status: 502 });

type Server = ReturnType<typeof realServer>;
type Rewrite = (request: Request, server: Server) => Promise<Response> | undefined;

const matches = (request: Request, method: string, path: string) =>
  request.method === method && new URL(request.url).pathname === `/api/v1${path}`;

function failing(method: string, path: string): Rewrite {
  return (request) => (matches(request, method, path) ? Promise.resolve(badGateway()) : undefined);
}

async function openPage(route: string, ...rewrites: Rewrite[]) {
  const server = realServer({ signedIn: true });
  await server.ready;
  const fetch = async (request: Request) => {
    for (const rewrite of rewrites) {
      const answer = rewrite(request, server);
      if (answer) return answer;
    }
    return server.fetch(request);
  };
  const { user } = renderDashboard(fetch, route);
  return { server, user };
}

const keys = async () => within(await screen.findByRole("region", { name: "Keys" }));

describe("a failure without a problem body", () => {
  it("reads the server-trouble sentence when the keys can't be loaded", async () => {
    const { user } = await openPage("/settings", failing("GET", "/secrets"));
    await openAdvanced(user);
    expect((await (await keys()).findByRole("alert")).textContent).toBe(SERVER_TROUBLE);
  });

  it("reads the server-trouble sentence when a key can't be saved", async () => {
    const { user } = await openPage("/settings", failing("PUT", "/secrets/anthropic"));
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Set Anthropic API key" }));
    await user.type(screen.getByLabelText("Anthropic API key value"), "sk-ant-made-up");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect((await (await keys()).findByRole("alert")).textContent).toBe(SERVER_TROUBLE);
  });

  it("reads the server-trouble sentence when a re-analysis can't start", async () => {
    const outdated: Rewrite = (request, server) =>
      matches(request, "GET", "/analysis")
        ? server.fetch(request).then(async (response) => {
            const status = await response.json();
            return Response.json({
              ...status,
              key: "present",
              olderVersion: { ...status.olderVersion, count: 2, estimatedCostUsd: 0.02 },
            });
          })
        : undefined;
    const { user } = await openPage("/settings", outdated, failing("POST", "/analysis/runs"));
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    const question = screen.getByRole("alertdialog", { name: "Re-analyse 2 offers?" });
    await user.click(within(question).getByRole("button", { name: "Re-analyse" }));
    expect((await within(question).findByRole("alert")).textContent).toBe(SERVER_TROUBLE);
  });

  it("reads the server-trouble sentence when the quiet hours can't be saved", async () => {
    const { user } = await openPage("/settings", failing("PUT", "/settings/crawl"));
    const from = await screen.findByLabelText("Quiet hours start");
    await waitFor(() => expect(from.getAttribute("data-value")).toBe("23:30"));
    await choose(user, from, "22:00");
    expect(await screen.findByText(SERVER_TROUBLE)).toBeTruthy();
  });

  it("reads the server-trouble sentence when Hide likely scams can't be saved", async () => {
    const { user } = await openPage("/settings", failing("PUT", "/filters"));
    const toggle = await screen.findByRole("switch", { name: "Hide likely scams" });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    await user.click(toggle);
    expect(await screen.findByText(SERVER_TROUBLE)).toBeTruthy();
  });

  it("reads the server-trouble sentence when hunting can't be paused", async () => {
    const { user } = await openPage("/settings", failing("POST", "/crawl/pause"));
    const toggle = await screen.findByRole("switch", { name: "Keep hunting" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    await user.click(toggle);
    expect(await screen.findByText(SERVER_TROUBLE)).toBeTruthy();
  });

  it("reads the server-trouble sentence when a Search can't be saved", async () => {
    const { user } = await openPage("/searches", failing("POST", "/searches"));
    await user.click(await screen.findByRole("button", { name: "Add a search" }));
    await user.type(screen.getByLabelText("City"), "Berlin");
    await user.click(screen.getByRole("checkbox", { name: "Flatshare room" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(SERVER_TROUBLE)).toBeTruthy();
  });

  it("reads the server-trouble sentence when the Profile can't be loaded", async () => {
    await openPage("/profile", failing("GET", "/profile"));
    expect(await screen.findByText(`Couldn't load your profile: ${SERVER_TROUBLE}`)).toBeTruthy();
  });

  it("reads the server-trouble sentence when the token can't be rotated", async () => {
    const { user } = await openPage("/settings", failing("POST", "/auth/token/rotate"));
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Rotate access token" }));
    await user.click(screen.getByRole("button", { name: "Rotate token" }));
    expect(await screen.findByText(SERVER_TROUBLE)).toBeTruthy();
  });

  it("reads the server-trouble sentence when the stored data can't be loaded", async () => {
    const { user } = await openPage("/settings", failing("GET", "/storage"));
    await openAdvanced(user);
    const heading = await screen.findByRole("heading", { level: 3, name: "Stored data" });
    const section = within(heading.closest("section") as HTMLElement);
    expect((await section.findByRole("alert")).textContent).toBe(SERVER_TROUBLE);
  });

  it("reads the server-trouble sentence when the pacing can't be saved", async () => {
    const { user } = await openPage("/settings", failing("PUT", "/settings/crawl"));
    await openAdvanced(user);
    await openFold(user, "Pacing");
    const region = within(await screen.findByRole("region", { name: "Pacing" }));
    const daily = (await region.findByLabelText("Most requests a day")) as HTMLInputElement;
    await user.clear(daily);
    await user.type(daily, "200");
    await user.click(region.getByRole("button", { name: "Save pacing" }));
    expect(await region.findByText(SERVER_TROUBLE)).toBeTruthy();
  });

  it("reads the server-trouble sentence, not a status code, when signing in fails", async () => {
    const server = fakeServer();
    const { user } = renderDashboard((request) =>
      matches(request, "POST", "/auth/session")
        ? Promise.resolve(badGateway())
        : server.fetch(request),
    );
    await user.type(await screen.findByLabelText("Access token"), "correct-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`wg-hunt refused the sign-in: ${SERVER_TROUBLE}`);
  });
});

describe("a sign-in that gets no answer", () => {
  it("says wg-hunt couldn't be reached in the same words as every other screen", async () => {
    const server = fakeServer();
    const { user } = renderDashboard((request) =>
      matches(request, "POST", "/auth/session")
        ? Promise.reject(new TypeError("Failed to fetch"))
        : server.fetch(request),
    );
    await user.type(await screen.findByLabelText("Access token"), "correct-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe(UNREACHABLE);
  });
});

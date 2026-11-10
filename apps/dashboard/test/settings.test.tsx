// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdvanced, openFold } from "./advanced.js";
import { choose, chosenLabel, optionsOf } from "./choose.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

// Made up; the middle is distinctive so any leak onto the page shows.
const KEY = "sk-ant-api03-ZXCVBNMASDFGHJKLQWERTYUIOP0123456789-a1b2";

async function openSettings(
  options: { fetchOverride?: (r: Request) => Promise<Response> | undefined } = {},
) {
  const server = realServer({ signedIn: true });
  await server.ready;
  const fetch = async (request: Request) =>
    (await options.fetchOverride?.(request)) ?? server.fetch(request);
  const { user } = renderDashboard(fetch, "/settings");
  await openAdvanced(user);
  await screen.findByRole("heading", { level: 3, name: "Reading model" });
  await screen.findByLabelText("Model");
  await openFold(user, "Prices");
  return { server, user };
}

const savedAnalysis = async (server: Awaited<ReturnType<typeof openSettings>>["server"]) =>
  (await server.asCli("/settings/analysis")).json();

describe("Settings: Analysis", () => {
  it("shows the defaults: Haiku 5.5 at medium, escalation at high, batch off, $5 cap", async () => {
    await openSettings();
    expect(chosenLabel(screen.getByLabelText("Model"))).toBe("claude-haiku-5-5");
    expect(chosenLabel(screen.getByLabelText("Effort"))).toBe("medium");
    expect(screen.getByLabelText("Second read when unsure").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(chosenLabel(screen.getByLabelText("Second read model"))).toBe("claude-haiku-5-5");
    expect(chosenLabel(screen.getByLabelText("Second read effort"))).toBe("high");
    expect(screen.getByLabelText("Always read in batches").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(
      (screen.getByLabelText("Monthly limit for reading offers") as HTMLInputElement).value,
    ).toBe("5");
  });

  it("saves the model, effort, escalation, batch and cap that were chosen", async () => {
    const { server, user } = await openSettings();
    await choose(user, screen.getByLabelText("Model"), "claude-sonnet-5-5");
    await choose(user, screen.getByLabelText("Effort"), "low");
    await choose(user, screen.getByLabelText("Second read model"), "claude-opus-5-5");
    await choose(user, screen.getByLabelText("Second read effort"), "max");
    await user.click(screen.getByLabelText("Always read in batches"));
    const limit = screen.getByLabelText("Monthly limit for reading offers");
    await user.clear(limit);
    await user.type(limit, "12.5");
    await user.tab();
    await waitFor(async () => expect((await savedAnalysis(server)).monthlySpendCapUsd).toBe(12.5));
    await user.click(screen.getByRole("button", { name: "Save reading model" }));

    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(await savedAnalysis(server)).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "low",
      escalation: { model: "claude-opus-5-5", effort: "max" },
      batchOnly: true,
      monthlySpendCapUsd: 12.5,
    });
  });

  it("turns the escalation pass off", async () => {
    const { server, user } = await openSettings();
    await user.click(screen.getByLabelText("Second read when unsure"));
    expect((screen.getByLabelText("Second read model") as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    await screen.findByText("Saved.");
    expect((await savedAnalysis(server)).escalation).toBeNull();
  });

  it("offers only the efforts the chosen model supports", async () => {
    const { user } = await openSettings();
    const options = () => optionsOf(user, screen.getByLabelText("Effort"));
    expect(await options()).toEqual(["low", "medium", "high", "xhigh", "max"]);

    await choose(user, screen.getByLabelText("Model"), "claude-sonnet-4-6");
    expect(await options()).toEqual(["low", "medium", "high", "max"]);

    await choose(user, screen.getByLabelText("Model"), "claude-haiku-4-5");
    const effort = screen.getByLabelText("Effort") as HTMLButtonElement;
    expect(effort.disabled).toBe(true);
    expect(chosenLabel(effort)).toBe("Not supported");
  });

  it("keeps the effort when the new model also supports it, and picks a supported one when not", async () => {
    const { user } = await openSettings();
    await choose(user, screen.getByLabelText("Effort"), "xhigh");
    await choose(user, screen.getByLabelText("Model"), "claude-opus-5-5");
    expect(chosenLabel(screen.getByLabelText("Effort"))).toBe("xhigh");
    await choose(user, screen.getByLabelText("Model"), "claude-sonnet-4-6");
    expect(chosenLabel(screen.getByLabelText("Effort"))).toBe("medium");
  });

  it("edits the price table", async () => {
    const { server, user } = await openSettings();
    const input = screen.getByLabelText("claude-haiku-5-5 input price");
    await user.clear(input);
    await user.type(input, "0.12");
    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    await screen.findByText("Saved.");
    const saved = await savedAnalysis(server);
    expect(
      saved.prices.find((p: { model: string }) => p.model === "claude-haiku-5-5"),
    ).toMatchObject({
      inputUsdPerMTok: 0.12,
      outputUsdPerMTok: 0.5,
    });
  });

  it("adds a model to the price table so it can be chosen, and removes one that is unused", async () => {
    const { server, user } = await openSettings();
    await user.type(screen.getByLabelText("Model id"), "claude-future-9");
    await user.type(screen.getByLabelText("Input price"), "1.5");
    await user.type(screen.getByLabelText("Output price"), "7");
    await user.click(screen.getByRole("checkbox", { name: "high" }));
    await user.click(screen.getByRole("checkbox", { name: "low" }));
    await user.click(screen.getByRole("button", { name: "Add to price table" }));

    await choose(user, screen.getByLabelText("Model"), "claude-future-9");
    expect(await optionsOf(user, screen.getByLabelText("Effort"))).toEqual(["low", "high"]);

    await user.click(screen.getByRole("button", { name: "Remove claude-opus-4-8" }));
    expect(screen.queryByLabelText("claude-opus-4-8 input price")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Remove claude-future-9" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    await screen.findByText("Saved.");
    const saved = await savedAnalysis(server);
    expect(saved.model).toBe("claude-future-9");
    expect(saved.prices.map((p: { model: string }) => p.model)).toContain("claude-future-9");
    expect(saved.prices.map((p: { model: string }) => p.model)).not.toContain("claude-opus-4-8");
  });

  it("marks unsaved changes and can revert them", async () => {
    const { user } = await openSettings();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await user.click(screen.getByLabelText("Always read in batches"));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Revert" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByLabelText("Always read in batches").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("does not send a spend cap that is not an amount", async () => {
    const { server, user } = await openSettings();
    const limit = screen.getByLabelText("Monthly limit for reading offers");
    await user.clear(limit);
    await user.type(limit, "lots");
    await user.tab();
    expect(await screen.findByText(/Enter an amount/)).toBeTruthy();
    expect((await savedAnalysis(server)).monthlySpendCapUsd).toBe(5);
  });

  it("shows what the server says when it refuses the settings", async () => {
    const { user } = await openSettings({
      fetchOverride: (request) =>
        request.method === "PUT"
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  type: "validation-error",
                  title: "Invalid request",
                  status: 400,
                  detail: "Model pass: claude-x does not support effort max.",
                }),
                { status: 400, headers: { "Content-Type": "application/problem+json" } },
              ),
            )
          : undefined,
    });
    await user.click(screen.getByLabelText("Always read in batches"));
    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    expect((await screen.findByRole("alert")).textContent).toContain("does not support effort max");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });
});

describe("Settings: Secrets", () => {
  it("shows the Anthropic key as not set", async () => {
    await openSettings();
    const row = (await screen.findByText("Anthropic API key")).closest("li") as HTMLElement;
    expect(within(row).getByText("Not set")).toBeTruthy();
    expect(
      (within(row).getByRole("button", { name: "Clear Anthropic API key" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("sets a key, shows only its masked hint afterwards, and never the value", async () => {
    const { server, user } = await openSettings();
    await user.click(await screen.findByRole("button", { name: "Set Anthropic API key" }));
    const field = screen.getByLabelText("Anthropic API key value") as HTMLInputElement;
    expect(field.type).toBe("password");
    await user.type(field, KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("sk-ant-…a1b2")).toBeTruthy();
    expect(screen.queryByLabelText("Anthropic API key value")).toBeNull();
    expect(document.body.textContent).not.toContain("ZXCVBNMASDFGHJKLQWERTYUIOP");
    expect(await (await server.asCli("/secrets")).json()).toEqual([
      expect.objectContaining({ name: "anthropic", set: true, masked: "sk-ant-…a1b2" }),
    ]);
  });

  it("clears a key once that is confirmed", async () => {
    const { server, user } = await openSettings();
    await server.asCli("/secrets/anthropic", {
      method: "PUT",
      body: JSON.stringify({ value: KEY }),
    });
    await user.click(screen.getByRole("link", { name: "Offers" }));
    await user.click(screen.getByRole("link", { name: "Settings" }));
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Clear Anthropic API key" }));
    const ask = () => screen.getByRole("alertdialog", { name: "Clear the Anthropic API key?" });
    await user.click(within(ask()).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("sk-ant-…a1b2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear Anthropic API key" }));
    await user.click(within(ask()).getByRole("button", { name: "Clear key" }));
    expect(await screen.findByText("Not set")).toBeTruthy();
    expect(await (await server.asCli("/secrets")).json()).toEqual([
      expect.objectContaining({ set: false, masked: null }),
    ]);
  });

  it("says why a Clear failed in its question, and not once the seeker moves on to Set", async () => {
    const { server, user } = await openSettings({
      fetchOverride: (request) =>
        request.method === "DELETE"
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  title: "Busy",
                  status: 503,
                  detail: "wg-hunt is busy right now.",
                }),
                { status: 503, headers: { "Content-Type": "application/problem+json" } },
              ),
            )
          : undefined,
    });
    await server.asCli("/secrets/anthropic", {
      method: "PUT",
      body: JSON.stringify({ value: KEY }),
    });
    await user.click(screen.getByRole("link", { name: "Offers" }));
    await user.click(screen.getByRole("link", { name: "Settings" }));
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Clear Anthropic API key" }));
    const ask = () => screen.getByRole("alertdialog", { name: "Clear the Anthropic API key?" });
    await user.click(within(ask()).getByRole("button", { name: "Clear key" }));

    expect((await within(ask()).findByRole("alert")).textContent).toBe(
      "wg-hunt is busy right now.",
    );
    await user.click(within(ask()).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Set Anthropic API key" }));
    expect(screen.getByLabelText("Anthropic API key value")).toBeTruthy();
    expect(screen.queryByText("wg-hunt is busy right now.")).toBeNull();
  });

  it("says so when the key is refused, and keeps the field open", async () => {
    const { user } = await openSettings();
    await user.click(await screen.findByRole("button", { name: "Set Anthropic API key" }));
    await user.type(screen.getByLabelText("Anthropic API key value"), "two words");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/spaces or line breaks/);
    expect(document.body.textContent).not.toContain("two words");
  });

  it("closes the field on Cancel without saving", async () => {
    const { server, user } = await openSettings();
    await user.click(await screen.findByRole("button", { name: "Set Anthropic API key" }));
    await user.type(screen.getByLabelText("Anthropic API key value"), KEY);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Anthropic API key value")).toBeNull();
    expect(await (await server.asCli("/secrets")).json()).toEqual([
      expect.objectContaining({ set: false }),
    ]);
  });
});

describe("Settings: Access token", () => {
  it("rotates after a confirmation, shows the new token once and stays signed in", async () => {
    const { server, user } = await openSettings();
    const oldToken = server.token;
    await user.click(screen.getByRole("button", { name: "Rotate access token" }));
    const question = screen.getByRole("alertdialog", { name: "Rotate the access token?" });
    expect(question.textContent).toMatch(/Every other browser is signed out/);
    expect((await server.asCli("/auth/session")).status).toBe(204); // nothing happened yet

    await user.click(screen.getByRole("button", { name: "Rotate token" }));
    const shown = (await screen.findByLabelText("New access token")) as HTMLInputElement;
    expect(shown.readOnly).toBe(true);
    expect(shown.value).toBe(server.token);
    expect(shown.value).not.toBe(oldToken);
    expect(screen.getByText(/shown only once/i)).toBeTruthy();

    const old = await server.asCli("/auth/session", {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    expect(old.status).toBe(401);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Offers" }));
    await user.click(screen.getByRole("link", { name: "Settings" }));
    await openAdvanced(user);
    expect(await screen.findByRole("heading", { level: 3, name: "Access token" })).toBeTruthy();

    await waitFor(() => expect(screen.queryByLabelText("New access token")).toBeNull());
  });

  it("hides the token when it is dismissed", async () => {
    const { user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Rotate access token" }));
    await user.click(screen.getByRole("button", { name: "Rotate token" }));
    await screen.findByLabelText("New access token");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("New access token")).toBeNull();
    expect(screen.getByRole("button", { name: "Rotate access token" })).toBeTruthy();
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const { server, user } = await openSettings();
    const before = server.token;
    await user.click(screen.getByRole("button", { name: "Rotate access token" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(server.token).toBe(before);
    expect(screen.getByRole("button", { name: "Rotate access token" })).toBeTruthy();
  });
});

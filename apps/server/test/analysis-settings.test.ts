import { describe, expect, it } from "vitest";
import { loadAnalysisSettings } from "../src/analysis-settings.js";
import { bootTestApp, tempDataDir } from "./helpers.js";

type App = ReturnType<typeof bootTestApp>["app"];

function client(app: App, token: string) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    get: () => app.request("/api/v1/settings/analysis", { headers }),
    put: (body: unknown) =>
      app.request("/api/v1/settings/analysis", {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      }),
  };
}

type Settings = {
  model: string;
  effort: string | null;
  escalation: { model: string; effort: string | null } | null;
  batchOnly: boolean;
  monthlySpendCapUsd: number;
  prices: {
    model: string;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    efforts: string[];
    longPrompt?: { aboveTokens: number; inputUsdPerMTok: number; outputUsdPerMTok: number } | null;
  }[];
};

async function current(app: App, token: string): Promise<Settings> {
  return (await client(app, token).get()).json();
}

describe("GET /settings/analysis", () => {
  it("starts with Haiku 5.5 at medium, escalation to the same model at high, $5 a month", async () => {
    const { app, token } = bootTestApp();
    const res = await client(app, token).get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "medium",
      escalation: { model: "claude-haiku-5-5", effort: "high" },
      batchOnly: false,
      monthlySpendCapUsd: 5,
    });
  });

  it("ships a price table whose known models name the efforts they support", async () => {
    const { app, token } = bootTestApp();
    const { prices } = await current(app, token);
    const haiku = prices.find((p) => p.model === "claude-haiku-5-5");
    expect(haiku).toEqual({
      model: "claude-haiku-5-5",
      inputUsdPerMTok: 0.1,
      outputUsdPerMTok: 0.5,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      longPrompt: { aboveTokens: 100_000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 },
    });
    // The previous Haiku has no effort parameter at all.
    expect(prices.find((p) => p.model === "claude-haiku-4-5")?.efforts).toEqual([]);
  });

  it("requires authentication", async () => {
    const { app } = bootTestApp();
    expect((await app.request("/api/v1/settings/analysis")).status).toBe(401);
  });
});

describe("PUT /settings/analysis", () => {
  it("keeps a model's long-prompt rate, and accepts a price table without one", async () => {
    const { app, token } = bootTestApp();
    const settings = await current(app, token);
    const withoutLong = settings.prices.map(({ longPrompt: _long, ...price }) => price);

    const res = await client(app, token).put({ ...settings, prices: withoutLong });

    expect(res.status).toBe(200);
    const saved = (await res.json()) as Settings;
    expect(saved.prices.every((price) => price.longPrompt === undefined)).toBe(true);

    const again = await client(app, token).put(settings);
    const haiku = ((await again.json()) as Settings).prices.find(
      (p) => p.model === "claude-haiku-5-5",
    );
    expect(haiku?.longPrompt).toEqual({
      aboveTokens: 100_000,
      inputUsdPerMTok: 0.5,
      outputUsdPerMTok: 2.5,
    });
  });

  it("saves every setting and returns them as saved", async () => {
    const { app, token } = bootTestApp();
    const api = client(app, token);
    const next: Settings = {
      ...(await current(app, token)),
      model: "claude-sonnet-5-5",
      effort: "low",
      escalation: { model: "claude-opus-5-5", effort: "max" },
      batchOnly: true,
      monthlySpendCapUsd: 12.5,
    };
    const put = await api.put(next);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(next);
    expect(await current(app, token)).toEqual(next);
  });

  it("keeps the settings across a restart", async () => {
    const dir = tempDataDir();
    const first = bootTestApp(dir);
    const next = {
      ...(await current(first.app, first.token)),
      monthlySpendCapUsd: 20,
      batchOnly: true,
    };
    await client(first.app, first.token).put(next);
    first.close();

    const second = bootTestApp(dir);
    expect(loadAnalysisSettings(second.db)).toEqual(next);
  });

  it("turns escalation off with null", async () => {
    const { app, token } = bootTestApp();
    const api = client(app, token);
    const next = { ...(await current(app, token)), escalation: null };
    expect((await api.put(next)).status).toBe(200);
    expect((await current(app, token)).escalation).toBeNull();
  });

  it("lets the price table be edited, and a model added to it be chosen", async () => {
    const { app, token } = bootTestApp();
    const api = client(app, token);
    const base = await current(app, token);
    const prices = [
      ...base.prices.map((p) =>
        p.model === "claude-haiku-5-5" ? { ...p, inputUsdPerMTok: 0.12, outputUsdPerMTok: 0.6 } : p,
      ),
      {
        model: "claude-future-9",
        inputUsdPerMTok: 1,
        outputUsdPerMTok: 3,
        efforts: ["low", "high"],
      },
    ];
    const next = { ...base, prices, model: "claude-future-9", effort: "high" };
    expect((await api.put(next)).status).toBe(200);
    const saved = await current(app, token);
    expect(saved.model).toBe("claude-future-9");
    expect(saved.prices.find((p) => p.model === "claude-haiku-5-5")).toMatchObject({
      inputUsdPerMTok: 0.12,
      outputUsdPerMTok: 0.6,
    });
  });

  describe("refuses", () => {
    async function refused(change: (base: Settings) => unknown, mentions: RegExp) {
      const { app, token } = bootTestApp();
      const base = await current(app, token);
      const res = await client(app, token).put(change(base));
      expect(res.status).toBe(400);
      const problem = await res.json();
      expect(problem.type).toBe("validation-error");
      expect(problem.detail).toMatch(mentions);
      expect(await current(app, token)).toEqual(base);
    }

    it("an effort the chosen model does not support", () =>
      refused(
        (base) => ({
          ...base,
          prices: [
            ...base.prices,
            {
              model: "claude-small-1",
              inputUsdPerMTok: 1,
              outputUsdPerMTok: 2,
              efforts: ["low", "medium"],
            },
          ],
          model: "claude-small-1",
          effort: "max",
        }),
        /claude-small-1.*max/s,
      ));

    it("an effort for a model that has no effort parameter", () =>
      refused(
        (base) => ({ ...base, model: "claude-haiku-4-5", effort: "medium" }),
        /claude-haiku-4-5/,
      ));

    it("no effort for a model that needs one", () =>
      refused((base) => ({ ...base, effort: null }), /effort/));

    it("an effort the escalation model does not support", () =>
      refused(
        (base) => ({ ...base, escalation: { model: "claude-haiku-4-5", effort: "high" } }),
        /escalation.*claude-haiku-4-5/is,
      ));

    it("a model that is not in the price table", () =>
      refused(
        (base) => ({ ...base, model: "claude-mystery-1" }),
        /claude-mystery-1.*price table/s,
      ));

    it("an escalation model that is not in the price table", () =>
      refused(
        (base) => ({ ...base, escalation: { model: "claude-mystery-1", effort: "high" } }),
        /claude-mystery-1.*price table/s,
      ));

    it("removing the chosen model from the price table", () =>
      refused(
        (base) => ({ ...base, prices: base.prices.filter((p) => p.model !== base.model) }),
        /price table/,
      ));

    it("an effort that no model has", () =>
      refused((base) => ({ ...base, effort: "extreme" }), /effort/i));

    it("a negative or non-numeric spend cap", async () => {
      await refused((base) => ({ ...base, monthlySpendCapUsd: -1 }), /monthlySpendCapUsd/);
      await refused((base) => ({ ...base, monthlySpendCapUsd: "five" }), /monthlySpendCapUsd/);
    });

    it("a negative price", () =>
      refused(
        (base) => ({
          ...base,
          prices: base.prices.map((p, i) => (i === 0 ? { ...p, inputUsdPerMTok: -0.1 } : p)),
        }),
        /inputUsdPerMTok/,
      ));

    it("the same model twice in the price table", () =>
      refused(
        (base) => ({ ...base, prices: [...base.prices, ...base.prices.slice(0, 1)] }),
        /more than once/,
      ));

    it("a body missing settings", () => refused(() => ({ model: "claude-haiku-5-5" }), /./));
  });
});

import { describe, expect, it } from "vitest";
import type { OfferText } from "../source/source.js";
import { analyseOffer, escalationRequest, firstRequest, readFirst, readSecond } from "./analyse.js";
import { ANALYSIS_PREFIX } from "./prompt.js";
import { emptyOutput, fakeProvider, outputWith, sure, unsure } from "./testing.js";

const text: OfferText = {
  title: "Zimmer",
  sections: [{ label: "Zimmer", text: "Das Zimmer ist hell. Anmeldung ist möglich." }],
};
const args = {
  text,
  category: "flatshare-room" as const,
  ruleFacts: {},
  model: { model: "claude-haiku-5-5", effort: "medium" as const },
  escalation: { model: "claude-haiku-5-5", effort: "high" as const },
};
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

const confident = outputWith({
  anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
});
const doubtful = outputWith({
  anmeldung: { value: "conditional", ...unsure("Anmeldung ist möglich") },
});

describe("reading an Offer one step at a time, as a batch does", () => {
  it("builds the same first request that analyseOffer sends", async () => {
    const { provider, requests } = fakeProvider([confident]);
    await analyseOffer({ ...args, provider });

    expect(firstRequest(args)).toEqual(requests[0]);
    expect(firstRequest(args).prefix).toBe(ANALYSIS_PREFIX);
  });

  it("is done after a confident first pass", () => {
    const step = readFirst(args, { output: confident, usage });

    expect(step.kind).toBe("done");
    if (step.kind === "done") {
      expect(step.result.escalated).toBe(false);
      expect(step.result.facts.anmeldung.value).toBe("possible");
    }
  });

  it("asks for an escalation after a Doubtful first pass, and has a provisional result meanwhile", () => {
    const step = readFirst(args, { output: doubtful, usage });

    expect(step.kind).toBe("escalate");
    if (step.kind !== "escalate") return;
    expect(step.request).toEqual(escalationRequest(args));
    expect(step.request.effort).toBe("high");
    expect(step.provisional.escalated).toBe(false);
    expect(step.provisional.facts.anmeldung.confidence?.status).toBe("doubtful");
  });

  it("is done at once, doubts and all, when escalation is off", () => {
    const step = readFirst({ ...args, escalation: null }, { output: doubtful, usage });

    expect(step.kind).toBe("done");
  });

  it("finishes with the escalation pass merged in, as analyseOffer would have", async () => {
    const step = readFirst(args, { output: doubtful, usage });
    if (step.kind !== "escalate") throw new Error("expected an escalation");

    const result = readSecond(args, step.state, { output: confident, usage });

    const { provider } = fakeProvider([doubtful, confident]);
    const inline = await analyseOffer({ ...args, provider });
    expect(result.escalated).toBe(true);
    expect(result.facts).toEqual(inline.facts);
    expect(result.log).toEqual(inline.log);
  });

  it("carries a state that survives being stored as JSON", () => {
    const step = readFirst(args, { output: doubtful, usage });
    if (step.kind !== "escalate") throw new Error("expected an escalation");

    const stored = JSON.parse(JSON.stringify(step.state));
    const result = readSecond(args, stored, { output: emptyOutput(), usage });

    expect(result.escalated).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { type AnalysisStatus, analysisNeedsYou, analysisNote } from "../src/analysis-status.js";

const status = (change: Partial<AnalysisStatus>): AnalysisStatus => ({
  status: "analyzed",
  next: "none",
  reason: null,
  at: null,
  willRead: false,
  ...change,
});

describe("an Offer's analysis note", () => {
  it("says reading resumes once what is in flight is done, not that the monthly limit is reached", () => {
    const note = analysisNote(
      status({ status: "waiting-for-in-flight", next: "wait", willRead: true }),
    );

    expect(note).toMatch(/being read right now/);
    expect(note).not.toMatch(/monthly limit is reached|resets/);
    expect(analysisNeedsYou(status({ status: "waiting-for-in-flight", next: "wait" }))).toBe(false);
  });

  it("asks for a click only when the server would take it", () => {
    const failed = { status: "needs-click" as const, reason: "truncated" };
    expect(analysisNote(status({ ...failed, next: "reanalyze" }))).toMatch(/Re-analyse to try/);

    const noKey = analysisNote(status({ ...failed, next: "add-key" }));
    expect(noKey).toMatch(/add an Anthropic API key/);
    expect(noKey).not.toMatch(/Re-analyse to try/);

    expect(analysisNote(status({ ...failed, next: "replace-key" }))).toMatch(/replace/i);
    expect(
      analysisNote(status({ ...failed, next: "raise-cap", at: "2026-11-30T23:00:00.000Z" })),
    ).toMatch(/monthly limit.*1 December|monthly limit.*30 November/);
    expect(analysisNote(status({ ...failed, next: "raise-cap", at: null }))).toMatch(
      /being read right now/,
    );
  });

  it("says a reading that could not be saved was made, instead of printing the reason's code", () => {
    const lost = { reason: "outcome_not_stored", next: "reanalyze" as const };
    for (const kind of ["needs-click", "kept-previous"] as const) {
      const note = analysisNote(status({ status: kind, ...lost }));
      expect(note, kind).toMatch(/could not be saved/);
      expect(note, kind).toMatch(/Re-analyse to try again/);
      expect(note, kind).not.toMatch(/outcome_not_stored/);
      expect(analysisNeedsYou(status({ status: kind, ...lost }))).toBe(true);
    }
    expect(analysisNote(status({ status: "kept-previous", ...lost }))).toMatch(
      /earlier one is shown/,
    );
    expect(analysisNote(status({ status: "needs-click", ...lost, next: "add-key" }))).toMatch(
      /add an Anthropic API key/,
    );
  });

  it("says to Recheck, not to Re-analyse, when the stored copy of the ad is what failed", () => {
    for (const reason of ["no_stored_page", "unreadable_page"]) {
      for (const kind of ["kept-previous", "escalation-lost", "waiting-for-page"] as const) {
        const page = status({ status: kind, next: "recheck", reason });
        const note = analysisNote(page);
        expect(note, kind).toMatch(/Recheck/);
        expect(note, kind).not.toMatch(/Re-analyse/);
        expect(analysisNeedsYou(page)).toBe(true);
      }
    }
    expect(
      analysisNote(status({ status: "kept-previous", next: "recheck", reason: "no_stored_page" })),
    ).toMatch(/earlier one is shown/);
    expect(
      analysisNote(
        status({ status: "escalation-lost", next: "recheck", reason: "no_stored_page" }),
      ),
    ).toMatch(/first reading is shown/);
    expect(
      analysisNote(status({ status: "escalation-lost", next: "reanalyze", reason: "refused" })),
    ).toMatch(/Re-analyse to try again/);
  });

  it("says what a lost escalation or a kept result waits for before it can be read again", () => {
    const lost = analysisNote(
      status({ status: "escalation-lost", next: "add-key", reason: "refused" }),
    );
    expect(lost).toMatch(/add an Anthropic API key/);
    expect(lost).not.toMatch(/Re-analyse to try/);

    expect(
      analysisNote(status({ status: "kept-previous", next: "replace-key", reason: "refused" })),
    ).toMatch(/earlier one is shown.*replace/i);
  });
});

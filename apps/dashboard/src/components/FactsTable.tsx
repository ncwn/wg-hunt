import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { doubtfulReasonLabel } from "../analysis.js";
import type { ApiClient } from "../api/client.js";
import type { Result } from "../api/result.js";
import { ALWAYS_OVERRIDABLE, editorFor, NOT_OVERRIDABLE, offersUnknown } from "../fact-editors.js";
import { useMutation } from "../mutation.js";
import {
  factLabel,
  formatFactValue,
  type Offer,
  type OfferFact,
  originLabel,
  overrideFact,
  revertFact,
} from "../offers.js";
import { Button } from "../ui/Button.js";
import {
  Checkbox,
  DateField,
  MonthField,
  SelectField,
  TextArea,
  TextField,
} from "../ui/controls.js";
import { Notice } from "../ui/status.js";
import { parseRows, type RequirementRow, RequirementRows, rowsOf } from "./RequirementRows.js";

const SHOWN_ELSEWHERE = new Set(["imageUrls"]);

function factRows(offer: Offer): [string, OfferFact][] {
  return Object.entries(offer.facts)
    .filter(([key]) => !SHOWN_ELSEWHERE.has(key))
    .flatMap(([key, fact]): [string, OfferFact][] =>
      Array.isArray(fact) ? fact.map((item) => [key, item]) : [[key, fact]],
    );
}

function DoubtfulChip({ fact }: { fact: OfferFact }) {
  if (fact.confidence?.status !== "doubtful") return null;
  return (
    <span className="od-fact-note od-fact-doubtful">
      Doubtful: {fact.confidence.reasons.map(doubtfulReasonLabel).join("; ")}
    </span>
  );
}

const json = (value: unknown, indent?: number) => JSON.stringify(value, null, indent);

function currentValue(offer: Offer, key: string): unknown {
  const fact = offer.facts[key];
  if (fact === undefined) return "unknown";
  return Array.isArray(fact) ? fact.map((item) => item.value) : fact.value;
}

/** Keyed by item value as JSON. */
function quotesOf(offer: Offer, key: string): Map<string, string> {
  const fact = offer.facts[key];
  if (!Array.isArray(fact)) return new Map();
  return new Map(
    fact
      .filter((item) => item.origin === "text" && item.quote !== "")
      .map((item) => [json(item.value), item.quote]),
  );
}

type Draft = {
  text: string;
  min: string;
  max: string;
  converted: boolean;
  none: boolean;
  picked: unknown[];
  rows: RequirementRow[];
};

function draftOf(key: string, current: unknown, quotes: Map<string, string>): Draft {
  const draft: Draft = {
    text: "",
    min: "",
    max: "",
    converted: false,
    none: false,
    picked: [],
    rows: [],
  };
  const editor = editorFor(key);
  if (current === "unknown")
    return editor.kind === "json" ? { ...draft, text: json(current) } : draft;
  switch (editor.kind) {
    case "choice":
      return { ...draft, text: json(current) };
    case "checklist":
      return { ...draft, picked: Array.isArray(current) ? current : [] };
    case "requirements":
      return { ...draft, rows: rowsOf(current, quotes) };
    case "number":
    case "text":
    case "month":
      return { ...draft, text: String(current) };
    case "date":
      return current === "none" ? { ...draft, none: true } : { ...draft, text: String(current) };
    case "money": {
      const money = current as { amount: number; converted: boolean };
      return { ...draft, text: String(money.amount), converted: money.converted };
    }
    case "range": {
      const range = current as { min?: number; max?: number };
      return { ...draft, min: String(range.min ?? ""), max: String(range.max ?? "") };
    }
    case "json":
      return { ...draft, text: json(current, 2) };
  }
}

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

function parseDraft(key: string, draft: Draft): Parsed {
  const editor = editorFor(key);
  const number = (text: string): number | undefined => {
    const parsed = Number(text);
    return text.trim() !== "" && Number.isFinite(parsed) ? parsed : undefined;
  };
  switch (editor.kind) {
    case "choice": {
      if (draft.text === "") return { ok: false, message: "Choose a value." };
      return { ok: true, value: JSON.parse(draft.text) as unknown };
    }
    case "checklist":
      // Ticking none is a value: the Offer has none of them.
      return { ok: true, value: draft.picked };
    case "requirements":
      return parseRows(editor, draft.rows);
    case "number": {
      const value = number(draft.text);
      if (value === undefined) return { ok: false, message: "Enter a number." };
      return { ok: true, value };
    }
    case "money": {
      const amount = number(draft.text);
      if (amount === undefined) return { ok: false, message: "Enter an amount in euros." };
      return { ok: true, value: { amount, converted: draft.converted } };
    }
    case "text":
    case "month":
      if (draft.text.trim() === "") return { ok: false, message: "Enter a value." };
      return { ok: true, value: draft.text.trim() };
    case "date":
      if (editor.orNone && draft.none) return { ok: true, value: "none" };
      if (draft.text === "") return { ok: false, message: "Pick a date." };
      return { ok: true, value: draft.text };
    case "range": {
      const min = number(draft.min);
      const max = number(draft.max);
      if (min === undefined && max === undefined) {
        return { ok: false, message: "Enter a lowest age, a highest age, or both." };
      }
      return {
        ok: true,
        value: { ...(min !== undefined && { min }), ...(max !== undefined && { max }) },
      };
    }
    case "json":
      try {
        return { ok: true, value: JSON.parse(draft.text) as unknown };
      } catch {
        return { ok: false, message: "That isn't valid JSON." };
      }
  }
}

function Field({
  factKey,
  draft,
  onChange,
  label,
  quotes,
}: {
  factKey: string;
  draft: Draft;
  onChange: (change: Partial<Draft>) => void;
  label: string;
  quotes: Map<string, string>;
}) {
  const editor = editorFor(factKey);
  const id = useId();
  switch (editor.kind) {
    case "choice":
      return (
        <SelectField
          id={id}
          label={label}
          value={draft.text}
          options={editor.options.map((option) => ({
            value: json(option.value),
            label: option.label,
          }))}
          onChange={(text) => onChange({ text })}
        />
      );
    case "checklist": {
      const ticked = new Set(draft.picked.map((value) => json(value)));
      const toggle = (value: unknown, on: boolean) =>
        onChange({
          picked: on
            ? [...draft.picked, value]
            : draft.picked.filter((item) => json(item) !== json(value)),
        });
      return (
        <fieldset className="od-checklist">
          <legend className="od-label">{label}</legend>
          {editor.options.map((option, index) => {
            const quote = quotes.get(json(option.value));
            const quoteId = `${id}-quote-${index}`;
            return (
              <div key={json(option.value)} className="od-checklist-item">
                <Checkbox
                  label={option.label}
                  checked={ticked.has(json(option.value))}
                  describedBy={quote === undefined ? undefined : quoteId}
                  onChange={(on) => toggle(option.value, on)}
                />
                {quote !== undefined && (
                  <p id={quoteId} className="od-quote">
                    <span className="od-quote-label">In the ad</span>“{quote}”
                  </p>
                )}
              </div>
            );
          })}
        </fieldset>
      );
    }
    case "requirements":
      return (
        <RequirementRows
          editor={editor}
          label={label}
          rows={draft.rows}
          onChange={(rows) => onChange({ rows })}
        />
      );
    case "number":
      return (
        <TextField
          id={id}
          className="od-field-short wh-number"
          label={label}
          inputMode={editor.integer ? "numeric" : "decimal"}
          autoComplete="off"
          {...(editor.unit ? { suffix: editor.unit } : {})}
          value={draft.text}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      );
    case "money":
      return (
        <>
          <TextField
            id={id}
            className="od-field-short wh-number"
            label={label}
            inputMode="decimal"
            autoComplete="off"
            prefix="€"
            suffix="a month"
            value={draft.text}
            onChange={(event) => onChange({ text: event.target.value })}
          />
          <Checkbox
            label="Worked out from a nightly or daily price"
            checked={draft.converted}
            onChange={(converted) => onChange({ converted })}
          />
        </>
      );
    case "text":
      return (
        <TextField
          id={id}
          label={label}
          type="text"
          value={draft.text}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      );
    case "month":
      return (
        <MonthField
          id={id}
          className="od-field-short"
          label={label}
          value={draft.text}
          onChange={(text) => onChange({ text })}
        />
      );
    case "date":
      return (
        <>
          <DateField
            className="od-field-short"
            label={label}
            value={draft.text || null}
            disabled={draft.none}
            onChange={(text) => onChange({ text: text ?? "" })}
          />
          {editor.orNone && (
            <Checkbox
              label="No end date"
              checked={draft.none}
              onChange={(none) => onChange({ none })}
            />
          )}
        </>
      );
    case "range":
      return (
        <div className="od-range">
          <TextField
            id={`${id}-min`}
            className="wh-number"
            label={`${label}: from`}
            inputMode="numeric"
            autoComplete="off"
            value={draft.min}
            onChange={(event) => onChange({ min: event.target.value })}
          />
          <TextField
            id={`${id}-max`}
            className="wh-number"
            label="to"
            inputMode="numeric"
            autoComplete="off"
            value={draft.max}
            onChange={(event) => onChange({ max: event.target.value })}
          />
        </div>
      );
    case "json":
      return (
        <TextArea
          id={id}
          label={`${label} as JSON`}
          rows={4}
          spellCheck={false}
          value={draft.text}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      );
  }
}

function OverrideForm({
  api,
  offer,
  factKey,
  onSaved,
  onCancel,
}: {
  api: ApiClient;
  offer: Offer;
  factKey: string;
  onSaved: (offer: Offer) => void;
  onCancel: () => void;
}) {
  const label = factLabel(factKey);
  const [quotes] = useState(() => quotesOf(offer, factKey));
  const [draft, setDraft] = useState(() => draftOf(factKey, currentValue(offer, factKey), quotes));
  const saving = useMutation();
  const busy = saving.busy;
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    form.current
      ?.querySelector<HTMLElement>("select, input:not(:disabled), textarea, button")
      ?.focus();
  }, []);

  function save(value: () => { ok: true; value: unknown } | { ok: false; message: string }) {
    void saving.run(async (): Promise<Result<undefined>> => {
      const parsed = value();
      if (!parsed.ok) return parsed;
      const result = await overrideFact(api, offer.id, factKey, parsed.value);
      if (!result.ok) return result;
      onSaved(result.data);
      return { ok: true, data: undefined };
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save(() => parseDraft(factKey, draft));
  }

  return (
    <form ref={form} className="od-form" aria-label={`Override ${label}`} onSubmit={submit}>
      <div>
        <p className="od-form-title">Override {label}</p>
        <p className="od-muted">Your value wins over what wg-hunt read in the ad, and stays.</p>
      </div>
      <Field
        factKey={factKey}
        draft={draft}
        label={label}
        quotes={quotes}
        onChange={(change) => setDraft((now) => ({ ...now, ...change }))}
      />
      <div className="od-actions">
        <Button type="submit" size="sm" variant="soft" disabled={busy}>
          Save override
        </Button>
        {offersUnknown(editorFor(factKey)) && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => save(() => ({ ok: true, value: "unknown" }))}
          >
            Set to unknown
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {saving.state.status === "failed" && <Notice tone="alarm">{saving.state.message}</Notice>}
    </form>
  );
}

/** Quotes are the Offer's page text, rendered as text. */
export function FactsTable({
  api,
  offer,
  onChanged,
}: {
  api: ApiClient;
  offer: Offer;
  onChanged: (offer: Offer) => void;
}) {
  const [editing, setEditing] = useState<string>();
  const reverting = useMutation(offer.id);
  const entries = factRows(offer);
  // A Doubtful `unknown` is shown: it says the text probably holds something the model missed.
  const stated = entries.filter(
    ([, fact]) => fact.value !== "unknown" || fact.confidence?.status === "doubtful",
  );
  const shownKeys = new Set(stated.map(([key]) => key));
  const corrected = new Set(offer.overrides);
  const outdated = new Set(offer.corrections.filter((c) => c.wordsChanged).map((c) => c.key));
  const changedSince = (key: string) =>
    outdated.has(key) && <span className="od-fact-note">The ad changed since.</span>;
  // Facts without a row to put the button on: the Offer does not say them, the model has not read
  // them yet, or the seeker corrected a list to none.
  const silent = [
    ...new Set([
      ...entries
        .filter(([, fact]) => fact.value === "unknown" && fact.confidence?.status !== "doubtful")
        .map(([key]) => key),
      ...ALWAYS_OVERRIDABLE.filter((key) => !shownKeys.has(key)),
      ...(offer.category === "flatshare-room" && !shownKeys.has("requirements")
        ? ["requirements"]
        : []),
      ...offer.overrides,
    ]),
  ].filter((key) => !shownKeys.has(key) && !NOT_OVERRIDABLE.has(key));

  function revert(key: string) {
    void reverting.run(async (): Promise<Result<undefined>> => {
      const result = await revertFact(api, offer.id, key);
      if (!result.ok) return result;
      onChanged(result.data);
      return { ok: true, data: undefined };
    });
  }

  const correct = (key: string) => (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Override ${factLabel(key)}`}
        onClick={() => setEditing(key)}
      >
        Override
      </Button>
      {corrected.has(key) && (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Revert ${factLabel(key)}`}
          disabled={reverting.busy}
          onClick={() => revert(key)}
        >
          Revert
        </Button>
      )}
    </>
  );
  const buttons = (key: string, isFirst: boolean) =>
    isFirst && !NOT_OVERRIDABLE.has(key) ? correct(key) : null;

  const seen = new Set<string>();
  return (
    <>
      <div className="wh-table-wrap">
        <table className="wh-table od-facts" aria-label="Offer Facts">
          <thead>
            <tr>
              <th scope="col">Fact</th>
              <th scope="col">Value</th>
              <th scope="col">Origin</th>
              <th scope="col">Quote</th>
              <th scope="col">
                <span className="wh-sr">Correct</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {stated.map(([key, fact], index) => {
              const isFirst = !seen.has(key);
              seen.add(key);
              const manual = fact.origin === "manual";
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a list fact has no id of its own
                <tr key={`${key}:${index}`} className={manual ? "od-fact-manual" : undefined}>
                  <th scope="row">{factLabel(key)}</th>
                  <td>
                    {formatFactValue(key, fact)}
                    <DoubtfulChip fact={fact} />
                    {fact.alternatives?.map((alternative) => (
                      <span
                        key={`${alternative.origin}:${alternative.quote}`}
                        className="od-fact-note"
                      >
                        {manual ? "Replaced" : "Also read"}:{" "}
                        {formatFactValue(key, { ...fact, value: alternative.value })} (
                        {originLabel(alternative.origin)})
                      </span>
                    ))}
                  </td>
                  <td>{originLabel(fact.origin)}</td>
                  <td className="od-fact-quote">
                    {manual ? (
                      <>
                        Your correction
                        {isFirst && changedSince(key)}
                      </>
                    ) : (
                      fact.quote
                    )}
                  </td>
                  <td>
                    <div className="od-fact-actions">{buttons(key, isFirst)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {silent.length > 0 && (
        <div className="od-block">
          <p className="od-muted">The ad doesn't say these, or wg-hunt hasn't read them yet:</p>
          <ul className="od-silent" aria-label="Facts without a value">
            {silent.map((key) => (
              <li key={key}>
                <span>
                  {factLabel(key)}
                  {changedSince(key)}
                </span>
                <span className="od-fact-actions">{correct(key)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {reverting.state.status === "failed" && (
        <Notice tone="alarm">Couldn't revert that. {reverting.state.message}</Notice>
      )}
      {editing !== undefined && (
        <OverrideForm
          key={editing}
          api={api}
          offer={offer}
          factKey={editing}
          onSaved={(saved) => {
            setEditing(undefined);
            onChanged(saved);
          }}
          onCancel={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

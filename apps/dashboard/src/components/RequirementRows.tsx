import { useEffect, useId, useState } from "react";
import type { FactEditor, RequirementKind, StrictnessOption } from "../fact-editors.js";
import { Button } from "../ui/Button.js";
import { SelectField, TextField } from "../ui/controls.js";

type RequirementsEditor = Extract<FactEditor, { kind: "requirements" }>;

export type RequirementRow = {
  /** Keeps a row's fields together while rows above it are removed. */
  id: number;
  kind: string;
  strictness: StrictnessOption["value"];
  value: string;
  quote?: string;
};

let lastRowId = 0;
const rowId = () => ++lastRowId;

const json = (value: unknown) => JSON.stringify(value);

const startingValue = (kind: RequirementKind | undefined): string =>
  kind?.value.kind === "implied" ? kind.value.value : "";

export function rowsOf(current: unknown, quotes: Map<string, string>): RequirementRow[] {
  if (!Array.isArray(current)) return [];
  return current.flatMap((item): RequirementRow[] => {
    if (typeof item !== "object" || item === null) return [];
    const requirement = item as {
      kind: string;
      strictness: StrictnessOption["value"];
      value: string;
    };
    const quote = quotes.get(json(item));
    return [
      {
        id: rowId(),
        kind: requirement.kind,
        strictness: requirement.strictness,
        value: requirement.value,
        ...(quote !== undefined && { quote }),
      },
    ];
  });
}

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

const LANGUAGE_CODE = /^[a-z]{2}$/;

/** No rows is a value: the Offer states no Requirements. */
export function parseRows(editor: RequirementsEditor, rows: RequirementRow[]): Parsed {
  const value: { kind: string; strictness: string; value: string }[] = [];
  for (const [index, row] of rows.entries()) {
    const name = `Requirement ${index + 1}`;
    const kind = editor.kinds.find((option) => option.kind === row.kind);
    if (kind === undefined) return { ok: false, message: `${name}: choose a kind.` };
    let typed: string;
    switch (kind.value.kind) {
      case "choice":
        if (!kind.value.options.some((option) => option.value === row.value)) {
          return { ok: false, message: `${name}: choose the ${kind.value.label.toLowerCase()}.` };
        }
        typed = row.value;
        break;
      case "implied":
        typed = kind.value.value;
        break;
      case "language":
        typed = row.value.trim().toLowerCase();
        if (!LANGUAGE_CODE.test(typed)) {
          return {
            ok: false,
            message: `${name}: enter the language as a two-letter code, such as de or en.`,
          };
        }
        break;
      case "text":
        typed = row.value.trim();
        if (typed === "") return { ok: false, message: `${name}: say what the Advertiser asks.` };
        break;
    }
    value.push({ kind: kind.kind, strictness: row.strictness, value: typed });
  }
  return { ok: true, value };
}

function ValueField({
  kind,
  row,
  id,
  onChange,
}: {
  kind: RequirementKind | undefined;
  row: RequirementRow;
  id: string;
  onChange: (value: string) => void;
}) {
  switch (kind?.value.kind) {
    case undefined:
    case "implied":
      return null;
    case "choice":
      return (
        <SelectField
          id={id}
          label={kind.value.label}
          value={row.value}
          options={kind.value.options}
          onChange={onChange}
        />
      );
    case "language":
      return (
        <TextField
          id={id}
          className="od-field-short"
          label="Language code"
          hint="Two letters, such as de"
          size={4}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          value={row.value}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "text":
      return (
        <TextField
          id={id}
          className="od-field-grow"
          label="What it says"
          value={row.value}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

export function RequirementRows({
  editor,
  label,
  rows,
  onChange,
}: {
  editor: RequirementsEditor;
  label: string;
  rows: RequirementRow[];
  onChange: (rows: RequirementRow[]) => void;
}) {
  const id = useId();
  const [focus, setFocus] = useState<string>();
  useEffect(() => {
    if (focus === undefined) return;
    document.getElementById(focus)?.focus();
    setFocus(undefined);
  }, [focus]);

  const kindOf = (kind: string) => editor.kinds.find((option) => option.kind === kind);
  const update = (target: number, change: Partial<RequirementRow>) =>
    onChange(rows.map((row) => (row.id === target ? { ...row, ...change } : row)));

  function add() {
    const first = editor.kinds[0];
    const row: RequirementRow = {
      id: rowId(),
      kind: first?.kind ?? "",
      strictness: "required",
      value: startingValue(first),
    };
    onChange([...rows, row]);
    setFocus(`${id}-${row.id}-kind`);
  }

  function remove(target: number) {
    onChange(rows.filter((row) => row.id !== target));
    setFocus(`${id}-add`);
  }

  return (
    <fieldset className="od-requirements">
      <legend className="od-label">{label}</legend>
      {rows.length === 0 && (
        <p className="od-muted">None yet. Saving like this says the ad asks for nothing.</p>
      )}
      {rows.map((row, index) => {
        const name = `Requirement ${index + 1}`;
        const field = `${id}-${row.id}`;
        const kind = kindOf(row.kind);
        return (
          <fieldset key={row.id} className="od-requirement">
            <legend className="od-label">{name}</legend>
            <SelectField
              id={`${field}-kind`}
              label="Kind"
              value={row.kind}
              describedBy={row.quote === undefined ? undefined : `${field}-quote`}
              options={editor.kinds.map((option) => ({ value: option.kind, label: option.label }))}
              onChange={(next) =>
                update(row.id, { kind: next, value: startingValue(kindOf(next)) })
              }
            />
            <SelectField
              id={`${field}-strictness`}
              label="Strictness"
              value={row.strictness}
              options={editor.strictness}
              onChange={(strictness) => update(row.id, { strictness })}
            />
            <ValueField
              kind={kind}
              row={row}
              id={`${field}-value`}
              onChange={(value) => update(row.id, { value })}
            />
            <Button
              size="sm"
              variant="secondary"
              className="od-requirement-remove"
              aria-label={`Remove ${name}`}
              onClick={() => remove(row.id)}
            >
              Remove
            </Button>
            {row.quote !== undefined && (
              <p id={`${field}-quote`} className="od-quote">
                <span className="od-quote-label">In the ad</span>“{row.quote}”
              </p>
            )}
          </fieldset>
        );
      })}
      <div>
        <Button size="sm" variant="secondary" id={`${id}-add`} onClick={add}>
          Add Requirement
        </Button>
      </div>
    </fieldset>
  );
}

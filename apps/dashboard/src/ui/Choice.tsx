import { type ReactNode, useId } from "react";
import { Icon } from "./Icon.js";

export function Checkbox({
  label,
  checked,
  onChange,
  describedBy,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  describedBy?: string | undefined;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native checkbox brings the browser's own box
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-describedby={describedBy}
      className={checked ? "wh-check is-on" : "wh-check"}
      onClick={() => onChange(!checked)}
    >
      <span className="wh-check-box" aria-hidden="true">
        {checked && <Icon name="check" size={14} />}
      </span>
      <span className="wh-check-text">
        <span>{label}</span>
      </span>
    </button>
  );
}

export type ChipOption<V extends string = string> = { value: V; label: string };

export function ChipGroup<V extends string>({
  legend,
  options,
  chosen,
  onChange,
  error,
  hideLegend = false,
  noteId: given,
}: {
  legend: string;
  options: readonly ChipOption<V>[];
  chosen: readonly V[];
  onChange: (chosen: V[]) => void;
  error?: string | undefined;
  hideLegend?: boolean;
  noteId?: string;
}) {
  const ownNote = useId();
  const noteId = given ?? ownNote;
  const flip = (value: V) =>
    onChange(
      options
        .map((option) => option.value)
        .filter((each) => (each === value ? !chosen.includes(value) : chosen.includes(each))),
    );
  return (
    <fieldset
      className={error ? "wh-chips has-error" : "wh-chips"}
      aria-describedby={error ? noteId : undefined}
    >
      <legend className={hideLegend ? "wh-sr" : "wh-field-label"}>{legend}</legend>
      <div className="wh-chips-items">
        {options.map(({ value, label }) => {
          const on = chosen.includes(value);
          return (
            // biome-ignore lint/a11y/useSemanticElements: a chip, drawn by the design system
            <button
              key={value}
              type="button"
              role="checkbox"
              aria-checked={on}
              className={on ? "wh-chip-pick is-on" : "wh-chip-pick"}
              onClick={() => flip(value)}
            >
              {on && <Icon name="check" size={16} />}
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      {error && (
        <p id={noteId} className="wh-field-hint">
          {error}
        </p>
      )}
    </fieldset>
  );
}

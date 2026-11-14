import { type KeyboardEvent, type ReactNode, useState } from "react";
import { TextField } from "./controls.js";

/**
 * Keeps the typed text while it still stands for the value (so "12." survives a keystroke), and
 * rewrites it when the value changes from outside.
 */
export function useTyped<T>(
  value: T,
  parse: (text: string) => T | undefined,
  show: (value: T) => string,
  same: (a: T, b: T) => boolean,
) {
  const [text, setText] = useState(() => show(value));
  // Only a changed value rewrites the text, and in the same render: an effect would show it a paint
  // late, so a field enabled together with its value (a setting that just loaded) would be blank
  // for a moment, and a key typed then would land on the value shown after it.
  const [shownFor, setShownFor] = useState(value);
  if (!Object.is(shownFor, value)) {
    setShownFor(value);
    const typed = parse(text);
    if (typed === undefined || !same(typed, value)) setText(show(value));
  }
  return [text, setText] as const;
}

function parseNumber(text: string): number | null | undefined {
  const tidy = text.trim().replace(",", ".");
  if (tidy === "") return null;
  if (!/^-?\d*\.?\d*$/.test(tidy) || tidy === "-" || tidy === ".") return undefined;
  const n = Number(tidy);
  return Number.isFinite(n) ? n : undefined;
}

export function NumberField({
  label,
  value,
  onChange,
  integer = false,
  min,
  max,
  prefix,
  suffix,
  error,
  bare = false,
  spoken,
  disabled,
  placeholder,
  onBlur,
  onEnter,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  integer?: boolean;
  min?: number;
  max?: number;
  prefix?: ReactNode;
  suffix?: ReactNode;
  error?: string | undefined;
  bare?: boolean;
  spoken?: string;
  disabled?: boolean | undefined;
  placeholder?: string;
  onBlur?: () => void;
  onEnter?: () => void;
}) {
  const [text, setText] = useTyped(
    value,
    parseNumber,
    (v) => (v === null ? "" : String(v)),
    Object.is,
  );

  function stepBy(direction: 1 | -1, event: KeyboardEvent) {
    event.preventDefault();
    let next = (value ?? min ?? 0) + direction;
    if (value === null && min !== undefined) next = min;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    next = Number(next.toFixed(6));
    setText(String(next));
    onChange(next);
  }

  return (
    <TextField
      className="wh-number"
      {...(bare ? {} : { label })}
      aria-label={spoken ?? (bare ? label : undefined)}
      prefix={prefix}
      suffix={suffix}
      error={error}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      autoComplete="off"
      disabled={disabled}
      placeholder={placeholder}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = parseNumber(event.target.value);
        if (parsed !== undefined) onChange(parsed);
      }}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") stepBy(1, event);
        else if (event.key === "ArrowDown") stepBy(-1, event);
        else if (event.key === "Enter") onEnter?.();
      }}
    />
  );
}

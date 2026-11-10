import {
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
} from "react";

export { Checkbox, ChipGroup } from "./Choice.js";
export { DateField } from "./DateField.js";
export { NumberField, useTyped } from "./NumberField.js";
export { MonthField, SelectField, SelectPill, TimeField } from "./Select.js";

export type Option<V extends string = string> = { value: V; label: ReactNode };

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  quiet = false,
  label,
  className,
  disabled = false,
}: {
  options: Option<V>[];
  value: V | undefined;
  onChange: (value: V) => void;
  quiet?: boolean;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const classes = ["wh-seg", quiet && "wh-seg-quiet", className].filter(Boolean).join(" ");
  return (
    <fieldset className={classes} aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={option.value === value ? "wh-seg-item is-on" : "wh-seg-item"}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "wh-toggle is-on" : "wh-toggle"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="wh-toggle-knob" />
    </button>
  );
}

type FieldNotes = {
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
};

function Field({
  label,
  hint,
  error,
  className,
  inputId,
  children,
}: FieldNotes & { className?: string | undefined; inputId: string; children: ReactNode }) {
  const note = error ?? hint;
  const classes = ["wh-field", error && "has-error", className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      {label && (
        <label className="wh-field-label" htmlFor={inputId}>
          {label}
        </label>
      )}
      {children}
      {note && (
        <p className="wh-field-hint" id={`${inputId}-hint`}>
          {note}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label,
  prefix,
  suffix,
  hint,
  error,
  className,
  id,
  ...rest
}: FieldNotes & {
  prefix?: ReactNode;
  suffix?: ReactNode;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "prefix">) {
  const own = useId();
  const inputId = id ?? own;
  const note = error ?? hint;
  return (
    <Field label={label} hint={hint} error={error} className={className} inputId={inputId}>
      <div className="wh-field-box">
        {prefix && <span className="wh-field-affix">{prefix}</span>}
        <input
          id={inputId}
          className="wh-field-input"
          aria-describedby={note ? `${inputId}-hint` : undefined}
          aria-invalid={error ? true : undefined}
          {...rest}
        />
        {suffix && <span className="wh-field-affix">{suffix}</span>}
      </div>
    </Field>
  );
}

export function TextArea({
  label,
  id,
  rows = 3,
  ...rest
}: { label?: string } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">) {
  const own = useId();
  const inputId = id ?? own;
  return (
    <Field label={label} inputId={inputId}>
      <div className="wh-field-box wh-field-box-multi">
        <textarea id={inputId} rows={rows} className="wh-field-input" {...rest} />
      </div>
    </Field>
  );
}

export function SettingRow({
  title,
  description,
  control,
  layout = "inline",
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  layout?: "inline" | "field";
}) {
  return (
    <div className={layout === "field" ? "wh-setting wh-setting-field" : "wh-setting"}>
      <div className="wh-setting-text">
        <p className="wh-setting-title">{title}</p>
        {description && <div className="wh-setting-desc">{description}</div>}
      </div>
      {control !== undefined && control !== null && (
        <div className="wh-setting-control">{control}</div>
      )}
    </div>
  );
}

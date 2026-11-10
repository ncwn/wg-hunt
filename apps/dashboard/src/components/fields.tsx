import { Segmented, SelectField, TextField, useTyped } from "../ui/controls.js";

export { NumberField } from "../ui/controls.js";

const parseList = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

type ListFieldProps = {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  bare?: boolean;
  placeholder?: string;
  transform?: (item: string) => string;
};

export function ListField({
  label,
  value,
  onChange,
  bare,
  placeholder,
  transform,
}: ListFieldProps) {
  const tidy = (items: string[]) => (transform ? items.map(transform) : items);
  const [text, setText] = useTyped(
    value,
    (t) => tidy(parseList(t)),
    (v) => v.join(", "),
    (a, b) => a.join("\u0000") === b.join("\u0000"),
  );
  return (
    <TextField
      {...(bare ? { "aria-label": label } : { label })}
      {...(placeholder && { placeholder })}
      type="text"
      autoComplete="off"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange(tidy(parseList(event.target.value)));
      }}
    />
  );
}

type Option<T extends string> = { value: T; label: string };

/** The record's key order is the order on screen. */
export const optionsOf = <T extends string>(labels: Record<T, string>): Option<T>[] =>
  (Object.entries(labels) as [T, string][]).map(([value, label]) => ({ value, label }));

export function OptionalSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: readonly Option<T>[];
  onChange: (value: T | null) => void;
}) {
  return (
    <SelectField
      hideLabel
      label={label}
      value={value ?? ""}
      options={[{ value: "", label: "Not said" }, ...options]}
      onChange={(choice) => onChange(choice === "" ? null : (choice as T))}
    />
  );
}

export function TriStateSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  const current = value === null ? "unset" : value ? "yes" : "no";
  return (
    <Segmented
      label={label}
      value={current}
      options={[
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
        { value: "unset", label: "Not said" },
      ]}
      onChange={(choice) => onChange(choice === "unset" ? null : choice === "yes")}
    />
  );
}

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { Popover, useDismiss } from "./Popover.js";

export type SelectOption<V extends string = string> = {
  value: V;
  label: string;
};

/** The WAI-ARIA "select-only combobox" pattern. */
function useSelect<V extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const chosen = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const optionId = (index: number) => `${id}-option-${index}`;

  useDismiss(open, anchor, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const node = list.current?.querySelector<HTMLElement>(`[id="${optionId(active)}"]`);
    node?.scrollIntoView?.({ block: "nearest" });
  });

  const show = (index: number) => {
    setActive(Math.min(options.length - 1, Math.max(0, index)));
    setOpen(true);
  };
  const pick = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value) onChange(option.value);
  };

  function typeahead(key: string) {
    const now = Date.now();
    const text = (now - typed.current.at < 500 ? typed.current.text : "") + key.toLowerCase();
    typed.current = { text, at: now };
    const from = open ? active : chosen;
    const order = [...options.keys()].map(
      (i) => (from + (text.length === 1 ? 1 : 0) + i) % options.length,
    );
    const found = order.find((i) => options[i]?.label.toLowerCase().startsWith(text));
    if (found !== undefined) show(found);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (disabled) return;
    const { key } = event;
    const handled = () => event.preventDefault();
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(key)) {
        handled();
        show(chosen);
      } else if (key === "Home") {
        handled();
        show(0);
      } else if (key === "End") {
        handled();
        show(options.length - 1);
      } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        handled();
        typeahead(key);
      }
      return;
    }
    switch (key) {
      case "ArrowDown":
        handled();
        return show(active + 1);
      case "ArrowUp":
        handled();
        if (event.altKey) return pick(active);
        return show(active - 1);
      case "Home":
        handled();
        return show(0);
      case "End":
        handled();
        return show(options.length - 1);
      case "PageDown":
        handled();
        return show(active + 10);
      case "PageUp":
        handled();
        return show(active - 10);
      case "Enter":
      case " ":
        handled();
        return pick(active);
      case "Escape":
        handled();
        return setOpen(false);
      case "Tab":
        return setOpen(false);
      default:
        if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          handled();
          typeahead(key);
        }
    }
  }

  const trigger = {
    role: "combobox" as const,
    "aria-haspopup": "listbox" as const,
    "aria-expanded": open,
    "aria-controls": `${id}-list`,
    "aria-activedescendant": open ? optionId(active) : undefined,
    disabled,
    onKeyDown,
    onClick: () => (open ? setOpen(false) : show(chosen)),
  };

  const menu = (title: ReactNode, labelledBy: string | undefined, ariaLabel?: string) => (
    <Popover open={open} anchor={anchor} onClose={() => setOpen(false)} title={title}>
      <div
        ref={list}
        id={`${id}-list`}
        role="listbox"
        tabIndex={-1}
        className="wh-menu"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : ariaLabel}
      >
        {options.map((option, index) => (
          // Focus stays on the trigger (aria-activedescendant): its keys pick, so an option takes no
          // focus and no key handler of its own.
          // biome-ignore lint/a11y/useKeyWithClickEvents: see above
          // biome-ignore lint/a11y/useFocusableInteractive: see above
          <div
            key={option.value}
            id={optionId(index)}
            role="option"
            aria-selected={index === chosen}
            data-value={option.value}
            className={[
              "wh-menu-item",
              index === active && "is-active",
              index === chosen && "is-chosen",
            ]
              .filter(Boolean)
              .join(" ")}
            onPointerMove={() => active !== index && setActive(index)}
            onClick={() => pick(index)}
          >
            <span className="wh-menu-text">
              <span>{option.label}</span>
            </span>
            {index === chosen && <Icon name="check" size={18} className="wh-menu-check" />}
          </div>
        ))}
      </div>
    </Popover>
  );

  return { open, anchor, trigger, menu, current: options[chosen] };
}

export function SelectField<V extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = "Choose…",
  error,
  disabled,
  hideLabel = false,
  "aria-label": ariaLabel,
  className,
  id: triggerId,
  describedBy,
}: {
  label?: string;
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  error?: string | undefined;
  disabled?: boolean | undefined;
  hideLabel?: boolean;
  "aria-label"?: string;
  className?: string;
  id?: string;
  describedBy?: string | undefined;
}) {
  const select = useSelect({ value, options, onChange, disabled });
  const id = useId();
  const known = options.some((option) => option.value === value);
  const classes = ["wh-field", error && "has-error", className].filter(Boolean).join(" ");
  const labelled = label && !ariaLabel;
  return (
    <div className={classes}>
      {label && (
        // A label, so a click on it opens the menu too.
        <label
          id={`${id}-label`}
          htmlFor={triggerId ?? `${id}-trigger`}
          className={hideLabel ? "wh-sr" : "wh-field-label"}
        >
          {label}
        </label>
      )}
      <span ref={select.anchor} className="wh-pop-anchor">
        <button
          id={triggerId ?? `${id}-trigger`}
          type="button"
          className="wh-field-box wh-field-trigger"
          data-value={value}
          aria-labelledby={labelled ? `${id}-label` : undefined}
          aria-label={labelled ? undefined : (ariaLabel ?? label)}
          aria-describedby={
            [error && `${id}-hint`, describedBy].filter(Boolean).join(" ") || undefined
          }
          aria-invalid={error ? true : undefined}
          {...select.trigger}
        >
          <span className={known ? "wh-field-value" : "wh-field-value is-empty"}>
            {known ? select.current?.label : placeholder}
          </span>
          <Icon name="chevronDown" size={18} className="wh-field-chev" />
        </button>
        {select.menu(ariaLabel ?? label, labelled ? `${id}-label` : undefined, ariaLabel)}
      </span>
      {error && (
        <p className="wh-field-hint" id={`${id}-hint`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function SelectPill<V extends string>({
  label,
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
}: {
  label?: string;
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  "aria-label"?: string;
}) {
  const select = useSelect({ value, options, onChange });
  const name = ariaLabel ?? label;
  return (
    <span ref={select.anchor} className="wh-pop-anchor">
      <button
        type="button"
        className={select.open ? "wh-select is-open" : "wh-select"}
        data-value={value}
        aria-label={name}
        {...select.trigger}
      >
        {label && (
          <span className="wh-select-label" aria-hidden="true">
            {label}
          </span>
        )}
        <span className="wh-select-value">{select.current?.label}</span>
        <Icon name="chevronDown" size={16} className="wh-select-chev" />
      </button>
      {select.menu(name, undefined, name)}
    </span>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

const HALF_HOURS = Array.from(
  { length: 48 },
  (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`,
);

export function TimeField({
  value,
  onChange,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
} & Omit<Parameters<typeof SelectField<string>>[0], "value" | "onChange" | "options">) {
  const times = value && !HALF_HOURS.includes(value) ? [...HALF_HOURS, value].sort() : HALF_HOURS;
  return (
    <SelectField
      placeholder="--:--"
      {...rest}
      value={value}
      options={times.map((time) => ({ value: time, label: time }))}
      onChange={onChange}
    />
  );
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function MonthField({
  value,
  onChange,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
} & Omit<Parameters<typeof SelectField<string>>[0], "value" | "onChange" | "options">) {
  const year = new Date().getFullYear();
  const months: string[] = [];
  for (let y = year - 2; y <= year + 3; y++) {
    for (let m = 1; m <= 12; m++) months.push(`${y}-${pad(m)}`);
  }
  if (/^\d{4}-\d{2}$/.test(value) && !months.includes(value)) months.push(value);
  months.sort();
  const label = (month: string) =>
    `${MONTH_NAMES[Number(month.slice(5)) - 1] ?? month.slice(5)} ${month.slice(0, 4)}`;
  return (
    <SelectField
      {...rest}
      value={value}
      options={months.map((month) => ({ value: month, label: label(month) }))}
      onChange={onChange}
    />
  );
}

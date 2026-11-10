import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import type { Result } from "../api/result.js";
import type { DraftSearch } from "../forecast.js";
import {
  CATEGORIES,
  categoryLabel,
  type NewSearch,
  RENT_TYPES,
  rentTypeLabel,
  type Search,
  type SearchChanges,
} from "../searches.js";
import { Button } from "../ui/Button.js";
import { ChipGroup, SelectField, TextField } from "../ui/controls.js";
import { Disclosure, Notice } from "../ui/status.js";

export type SearchFields = Required<Omit<NewSearch, "source" | "enabled">>;

type Values = {
  city: string;
  cityId: string;
  categories: Search["categories"];
  rentTypes: Search["rentTypes"];
  priceCeiling: string;
  recencyDays: string;
  minMinutes: string;
  maxMinutes: string;
};

// The server applies the same defaults when a client leaves a field out.
const BLANK: Values = {
  city: "",
  cityId: "",
  categories: [],
  rentTypes: [...RENT_TYPES],
  priceCeiling: "",
  recencyDays: "7",
  minMinutes: "30",
  maxMinutes: "60",
};

export type SearchStart = Partial<
  Pick<SearchFields, "city" | "categories" | "rentTypes" | "priceCeiling" | "recencyDays">
>;

function valuesOfStart(start: SearchStart | undefined): Values {
  if (!start) return BLANK;
  return {
    ...BLANK,
    city: start.city ?? BLANK.city,
    categories: start.categories ?? BLANK.categories,
    rentTypes: start.rentTypes ?? BLANK.rentTypes,
    priceCeiling:
      start.priceCeiling === undefined || start.priceCeiling === null
        ? BLANK.priceCeiling
        : String(start.priceCeiling),
    recencyDays: start.recencyDays === undefined ? BLANK.recencyDays : String(start.recencyDays),
  };
}

type NumberField = "priceCeiling" | "recencyDays" | "minMinutes" | "maxMinutes";

function valuesOf(search: Search): Values {
  return {
    city: search.city,
    cityId: search.cityId ?? "",
    categories: search.categories,
    rentTypes: search.rentTypes,
    priceCeiling: search.priceCeiling === null ? "" : String(search.priceCeiling),
    recencyDays: String(search.recencyDays),
    minMinutes: String(search.pollInterval.minMinutes),
    maxMinutes: String(search.pollInterval.maxMinutes),
  };
}

function fieldsOf(values: Values): SearchFields {
  return {
    city: values.city.trim(),
    cityId: values.cityId.trim() === "" ? null : values.cityId.trim(),
    categories: values.categories,
    rentTypes: values.rentTypes,
    priceCeiling: values.priceCeiling.trim() === "" ? null : Number(values.priceCeiling),
    recencyDays: Number(values.recencyDays),
    pollInterval: {
      minMinutes: Number(values.minMinutes),
      maxMinutes: Number(values.maxMinutes),
    },
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

/**
 * The lists compare as sets: the chips re-order them, and the server takes a re-ordered list as an
 * edit, which starts a Backfill. The two waits are one field to the server.
 */
function changesOf(opened: SearchFields, now: SearchFields): SearchChanges {
  const changes: SearchChanges = {};
  if (now.city !== opened.city) changes.city = now.city;
  if (now.cityId !== opened.cityId) changes.cityId = now.cityId;
  if (!sameSet(now.categories, opened.categories)) changes.categories = now.categories;
  if (!sameSet(now.rentTypes, opened.rentTypes)) changes.rentTypes = now.rentTypes;
  if (now.priceCeiling !== opened.priceCeiling) changes.priceCeiling = now.priceCeiling;
  if (now.recencyDays !== opened.recencyDays) changes.recencyDays = now.recencyDays;
  if (
    now.pollInterval.minMinutes !== opened.pollInterval.minMinutes ||
    now.pollInterval.maxMinutes !== opened.pollInterval.maxMinutes
  ) {
    changes.pollInterval = now.pollInterval;
  }
  return changes;
}

/** The server allows one to seven days. */
const RECENCY = Array.from({ length: 7 }, (_, i) => ({
  value: String(i + 1),
  label: i === 0 ? "Last day" : `Last ${i + 1} days`,
}));

/** The server's bounds on a wait between polls; the server has the last word on them. */
const POLL_MINUTES = { min: 15, max: 24 * 60 };

/** The server's bounds on a price ceiling, in euros. */
const PRICE_CEILING = { min: 1, max: 100_000 };

/** A ceiling that isn't a number would be sent as null, which the server reads as no ceiling. */
function priceCeilingError(text: string): string | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  if (!Number.isInteger(n)) return "Enter a whole number of euros, or leave it empty";
  const euros = (bound: number) => `€ ${bound.toLocaleString("en")}`;
  if (n < PRICE_CEILING.min) return `Enter at least ${euros(PRICE_CEILING.min)}, or leave it empty`;
  if (n > PRICE_CEILING.max) return `Enter at most ${euros(PRICE_CEILING.max)}`;
  return undefined;
}

function draftOf(values: Values, search: Search | undefined): DraftSearch | undefined {
  const recencyDays = Number(values.recencyDays);
  const minMinutes = Number(values.minMinutes);
  const maxMinutes = Number(values.maxMinutes);
  const wait = (n: number) => Number.isInteger(n) && n >= POLL_MINUTES.min && n <= POLL_MINUTES.max;
  if (values.categories.length === 0) return undefined;
  if (!Number.isInteger(recencyDays) || recencyDays < 1 || recencyDays > 7) return undefined;
  if (!wait(minMinutes) || !wait(maxMinutes) || minMinutes > maxMinutes) return undefined;
  // The city decides whether the Source can read the Search at all, and so whether it costs anything.
  const { city, cityId } = fieldsOf(values);
  return {
    ...(search && { id: search.id }),
    city,
    cityId,
    categories: values.categories,
    recencyDays,
    enabled: search?.enabled ?? true,
    pollInterval: { minMinutes, maxMinutes },
  };
}

type FieldKey =
  | "city"
  | "cityId"
  | "categories"
  | "rentTypes"
  | "priceCeiling"
  | "recencyDays"
  | "pollInterval.minMinutes"
  | "pollInterval.maxMinutes";

const FIELD_KEYS: FieldKey[] = [
  "city",
  "cityId",
  "categories",
  "rentTypes",
  "priceCeiling",
  "recencyDays",
  "pollInterval.minMinutes",
  "pollInterval.maxMinutes",
];

function sortErrors(errors: { path: string; message: string }[]) {
  const byField: Partial<Record<FieldKey, string[]>> = {};
  const general: string[] = [];
  for (const { path, message } of errors) {
    // A list's items report as "categories.1": the whole group carries the message.
    const key = FIELD_KEYS.find((k) => path === k || path.startsWith(`${k}.`));
    if (key) byField[key] = [...(byField[key] ?? []), message];
    // A path names a field, not something the seeker would recognise: the message says enough.
    else general.push(message);
  }
  return { byField, general };
}

function withoutErrorsFor(
  errors: ReturnType<typeof sortErrors>,
  key: keyof Values,
): ReturnType<typeof sortErrors> {
  const fields: FieldKey[] =
    key === "minMinutes" || key === "maxMinutes"
      ? ["pollInterval.minMinutes", "pollInterval.maxMinutes"]
      : [key];
  if (errors.general.length === 0 && fields.every((field) => !errors.byField[field])) return errors;
  const byField = { ...errors.byField };
  for (const field of fields) delete byField[field];
  return { byField, general: [] };
}

type Props = {
  start?: SearchStart;
  onCancel: () => void;
  onDraft: (draft: DraftSearch | undefined) => void;
} & (
  | { search: Search; onSubmit: (changes: SearchChanges) => Promise<Result<unknown>> }
  | { search?: undefined; onSubmit: (fields: SearchFields) => Promise<Result<unknown>> }
);

export function SearchForm(props: Props) {
  const { search, start, onCancel, onDraft } = props;
  // Edits are told against this copy, never the live `search`: a change made elsewhere since the
  // form opened would otherwise look like the seeker's own and be undone.
  const [opened] = useState<Values>(() => (search ? valuesOf(search) : valuesOfStart(start)));
  const [values, setValues] = useState<Values>(opened);
  const [errors, setErrors] = useState<ReturnType<typeof sortErrors>>({ byField: {}, general: [] });
  const [busy, setBusy] = useState(false);
  const id = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the values change what is told
  useEffect(() => onDraft(draftOf(values, search)), [values]);
  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => withoutErrorsFor(current, key));
  };

  function submitChecked(event: FormEvent) {
    const refused = priceCeilingError(values.priceCeiling);
    if (refused === undefined) return submit(event);
    event.preventDefault();
    setErrors({ byField: { priceCeiling: [refused] }, general: [] });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    let result: Result<unknown>;
    if (props.search === undefined) {
      setBusy(true);
      result = await props.onSubmit(fieldsOf(values));
    } else {
      const changes = changesOf(fieldsOf(opened), fieldsOf(values));
      if (Object.keys(changes).length === 0) {
        onCancel();
        return;
      }
      setBusy(true);
      result = await props.onSubmit(changes);
    }
    if (!result.ok) {
      const fieldErrors = result.errors ?? [];
      const sorted = sortErrors(fieldErrors);
      if (fieldErrors.length === 0) sorted.general.push(result.message);
      setErrors(sorted);
      setBusy(false);
    }
  }

  const errorId = (key: FieldKey) => `${id}-${key}-error`;
  const message = (key: FieldKey) => errors.byField[key]?.join(" ");
  const moreHasError = [
    "rentTypes",
    "cityId",
    "pollInterval.minMinutes",
    "pollInterval.maxMinutes",
  ].some((key) => errors.byField[key as FieldKey]);

  const number = (
    key: FieldKey,
    name: NumberField,
    label: string,
    extra: { prefix?: string; suffix?: string; placeholder?: string; bare?: boolean } = {},
  ): ReactNode => (
    <TextField
      className="wh-number"
      {...(extra.bare ? { "aria-label": label } : { label })}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={values[name]}
      onChange={(event) => set(name, event.target.value)}
      error={message(key)}
      {...(extra.prefix && { prefix: extra.prefix })}
      {...(extra.suffix && { suffix: extra.suffix })}
      {...(extra.placeholder && { placeholder: extra.placeholder })}
    />
  );

  const waitError = [message("pollInterval.minMinutes"), message("pollInterval.maxMinutes")]
    .filter(Boolean)
    .join(" ");

  return (
    <form className="sf" onSubmit={submitChecked} noValidate>
      <div className="sf-grid">
        <TextField
          label="City"
          type="text"
          autoComplete="off"
          value={values.city}
          onChange={(event) => set("city", event.target.value)}
          error={message("city")}
        />
        {number("priceCeiling", "priceCeiling", "Most you'll pay, warm", {
          prefix: "€",
          placeholder: "No limit",
        })}
      </div>

      <ChipGroup
        legend="What are you after?"
        options={CATEGORIES.map((value) => ({ value, label: categoryLabel(value) }))}
        chosen={values.categories}
        onChange={(next) => set("categories", next)}
        error={message("categories")}
        noteId={errorId("categories")}
      />

      <div className="sf-grid">
        <SelectField
          label="How recent should ads be?"
          value={values.recencyDays}
          options={RECENCY}
          onChange={(next) => set("recencyDays", next)}
          error={message("recencyDays")}
        />
      </div>

      <Disclosure quiet title="More options" {...(moreHasError && { open: true })}>
        <div className="sf-more">
          <ChipGroup
            legend="What kind of rent?"
            options={RENT_TYPES.map((value) => ({ value, label: rentTypeLabel(value) }))}
            chosen={values.rentTypes}
            onChange={(next) => set("rentTypes", next)}
            error={message("rentTypes")}
            noteId={errorId("rentTypes")}
          />
          <div className="sf-grid">
            <TextField
              label="City number on wg-gesucht (optional)"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="Known for Berlin and 20 more"
              value={values.cityId}
              onChange={(event) => set("cityId", event.target.value)}
              error={message("cityId")}
              hint="The number after the city in a wg-gesucht link"
            />
            <fieldset
              className={waitError ? "sf-range has-error" : "sf-range"}
              aria-describedby={waitError ? errorId("pollInterval.minMinutes") : undefined}
            >
              <legend className="wh-field-label">Check every</legend>
              <div className="sf-range-fields">
                {number("pollInterval.minMinutes", "minMinutes", "Shortest wait between checks", {
                  bare: true,
                })}
                <span aria-hidden="true">–</span>
                {number("pollInterval.maxMinutes", "maxMinutes", "Longest wait between checks", {
                  bare: true,
                  suffix: "min",
                })}
              </div>
              {waitError && (
                <p id={errorId("pollInterval.minMinutes")} className="wh-field-hint sf-error">
                  {waitError}
                </p>
              )}
            </fieldset>
          </div>
        </div>
      </Disclosure>

      {errors.general.length > 0 && <Notice tone="alarm">{errors.general.join(" ")}</Notice>}

      <div className="sf-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          Save
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

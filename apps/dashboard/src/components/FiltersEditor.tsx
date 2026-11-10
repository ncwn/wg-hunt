import type { ReactNode } from "react";
import type { Filters, Margin, Place, Strength } from "../seeking.js";
import { ChipGroup, Segmented, SelectField, SettingRow, Toggle } from "../ui/controls.js";
import { Disclosure } from "../ui/status.js";
import { ListField, NumberField, optionsOf } from "./fields.js";

type Key = keyof Filters;

const LABELS: Record<Key, string> = {
  anmeldung: "Anmeldung",
  genderSought: "Gender sought",
  requirements: "Requirements you contradict",
  ageSought: "Age sought",
  moveIn: "Move-in window",
  stayAvailable: "Available as long as you stay",
  stayMinimum: "Minimum stay no longer than yours",
  maxRent: "Max warm rent",
  minSize: "Min size",
  maxRentPerSqm: "Max rent per m²",
  furnished: "Furnishing",
  smoking: "Smoking",
  pets: "Pets",
  flatshareTypes: "Flatshare types",
  area: "District or PLZ",
  distance: "Distance to a Place",
  languages: "Flat speaks your language",
  hideLikelyScams: "Hide likely scams",
  flatmateAges: "Flatmate ages",
};

/** `LABELS` stays the control's spoken name; refusals name Filters by these too. */
export const FILTER_QUESTIONS: Record<Key, { title: string }> = {
  maxRent: { title: "What's the most you'll pay, warm?" },
  minSize: { title: "How small is too small?" },
  maxRentPerSqm: { title: "What's the most you'll pay per m²?" },
  distance: { title: "How far is too far?" },
  area: { title: "Only certain districts?" },
  moveIn: { title: "Should the room be free when you need it?" },
  stayAvailable: { title: "Should it be free for as long as you're staying?" },
  stayMinimum: { title: "Is a long minimum stay a problem?" },
  anmeldung: { title: "Should the room allow Anmeldung?" },
  genderSought: { title: "Should the flatmates be open to your gender?" },
  ageSought: { title: "Should they want someone your age?" },
  requirements: { title: "Does the ad ask for something you can't give?" },
  languages: { title: "Should the flat speak your language?" },
  flatmateAges: { title: "How old should the flatmates be?" },
  furnished: { title: "Which furnishing is fine?" },
  smoking: { title: "Is smoking in the flat a problem?" },
  pets: { title: "Does the flat need to allow pets?" },
  flatshareTypes: { title: "Which kinds of WG are you after?" },
  hideLikelyScams: { title: "Hide likely scams?" },
};

// Typed as a record so that a furnishing added to the API fails to compile here.
const FURNISHED = optionsOf<Filters["furnished"]["accept"][number]>({
  furnished: "Furnished",
  partly_furnished: "Partly furnished",
  unfurnished: "Unfurnished",
});

type FlatshareType = Filters["flatshareTypes"]["anyOf"][number];
// Typed as a record so that a flatshare type added to the API fails to compile here.
const FLATSHARE_TYPES: Record<FlatshareType, string> = {
  purpose_wg: "Purpose flatshare (Zweck-WG)",
  students: "Students",
  women_only: "Women only",
  men_only: "Men only",
  business: "Business",
  dormitory: "Dormitory",
  working_professionals: "Working professionals",
  trainees: "Trainees",
  seniors: "Seniors",
  with_children: "With children",
  fraternity: "Fraternity",
  not_purpose_wg: "Not a purpose flatshare",
  mixed_gender: "Mixed gender",
  plus: "WG plus",
  multigenerational: "Multigenerational",
  vegetarian_vegan: "Vegetarian or vegan",
  lgbtqia: "LGBTQIA+",
  living_for_help: "Living for help",
  single_parents: "Single parents",
  internationals_welcome: "Internationals welcome",
  inclusive: "Inclusive",
  functional: "Functional",
  new_flatshare: "New flatshare",
  no_gender_given: "No gender given",
};

const FLATSHARE_OPTIONS = (Object.keys(FLATSHARE_TYPES) as FlatshareType[]).map((value) => ({
  value,
  label: FLATSHARE_TYPES[value],
}));

const GROUPS: { title: string; keys: Key[] }[] = [
  { title: "Rent and size", keys: ["maxRent", "minSize", "maxRentPerSqm"] },
  { title: "Where", keys: ["distance", "area"] },
  { title: "When", keys: ["moveIn", "stayAvailable", "stayMinimum"] },
  {
    title: "People",
    keys: ["anmeldung", "genderSought", "ageSought", "requirements", "languages", "flatmateAges"],
  },
  { title: "The flat", keys: ["furnished", "smoking", "pets", "flatshareTypes"] },
  { title: "Scams", keys: ["hideLikelyScams"] },
];

const UNITS: Partial<Record<Key, string>> = {
  maxRent: "€",
  minSize: "m²",
  maxRentPerSqm: "€/m²",
  distance: "km",
};

const STRENGTHS: { value: Strength; label: string }[] = [
  { value: "dealbreaker", label: "Hide it" },
  { value: "want", label: "Near match" },
];

function MarginField({
  name,
  unit,
  margin,
  onChange,
}: {
  name: string;
  unit: string;
  margin: Margin | null;
  onChange: (margin: Margin | null) => void;
}) {
  return (
    <div className="pf-margin">
      <NumberField
        label="Give or take"
        spoken={`${name} margin`}
        placeholder="0"
        value={margin?.value ?? null}
        onChange={(value) =>
          onChange(value === null ? null : { value, unit: margin?.unit ?? "absolute" })
        }
      />
      <Segmented
        label={`${name} margin unit`}
        className="pf-unit"
        value={margin?.unit ?? "absolute"}
        options={[
          { value: "absolute", label: unit },
          { value: "percent", label: "%" },
        ]}
        onChange={(next) => margin && onChange({ ...margin, unit: next })}
      />
    </div>
  );
}

export function FiltersEditor({
  filters,
  places,
  onChange,
}: {
  filters: Filters;
  places: Place[];
  onChange: (filters: Filters) => void;
}) {
  const patch = (key: Key, change: object) =>
    onChange({ ...filters, [key]: { ...filters[key], ...change } });

  function row(key: Key, settings: ReactNode) {
    const filter = filters[key];
    const name = LABELS[key];
    const { title } = FILTER_QUESTIONS[key];
    const strict = key !== "hideLikelyScams";
    return (
      <div key={key} className="pf-filter" data-off={filter.enabled ? undefined : "true"}>
        <SettingRow
          title={title}
          control={
            <Toggle
              label={name}
              checked={filter.enabled}
              onChange={(enabled) => patch(key, { enabled })}
            />
          }
        />
        {filter.enabled && (strict || settings) && (
          <div className="pf-detail">
            {settings}
            {strict && (
              <div className="wh-field pf-strength">
                <span className="wh-field-label" aria-hidden="true">
                  A room that misses
                </span>
                <Segmented
                  label={`${name}: how strict`}
                  value={filter.strength}
                  options={STRENGTHS}
                  onChange={(strength: Strength) => patch(key, { strength })}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function numeric(key: "maxRent" | "minSize" | "maxRentPerSqm" | "distance", extra?: ReactNode) {
    const filter = filters[key];
    const name = LABELS[key];
    const unit = UNITS[key] ?? "";
    return (
      <>
        {extra}
        <NumberField
          label={key === "minSize" ? "At least" : "At most"}
          spoken={`${name} limit`}
          suffix={unit}
          placeholder="No limit"
          value={filter.limit}
          onChange={(limit) => patch(key, { limit })}
        />
        <MarginField
          name={name}
          unit={unit}
          margin={filter.margin}
          onChange={(margin) => patch(key, { margin })}
        />
      </>
    );
  }

  function settings(key: Key): ReactNode {
    switch (key) {
      case "maxRent":
      case "minSize":
      case "maxRentPerSqm":
        return numeric(key);
      case "distance": {
        const named = places.map((place) => place.name).filter((name) => name.trim() !== "");
        const current = filters.distance.place;
        return numeric(
          "distance",
          <SelectField
            label="From"
            aria-label="Distance to a Place: which Place"
            value={current ?? ""}
            placeholder="Choose a place"
            options={[
              { value: "", label: "No place chosen" },
              ...(current !== null && !named.includes(current)
                ? [{ value: current, label: `${current} (not in your places)` }]
                : []),
              ...named.map((name) => ({ value: name, label: name })),
            ]}
            onChange={(place) => patch("distance", { place: place === "" ? null : place })}
          />,
        );
      }
      case "moveIn":
        return (
          <NumberField
            integer
            label="Give or take"
            spoken={`${LABELS.moveIn} margin`}
            suffix="days"
            value={filters.moveIn.marginDays}
            onChange={(marginDays) => patch("moveIn", { marginDays })}
          />
        );
      case "furnished":
        return (
          <ChipGroup
            hideLegend
            legend="Accepted furnishing"
            options={FURNISHED}
            chosen={filters.furnished.accept}
            onChange={(accept) => patch("furnished", { accept })}
          />
        );
      case "flatshareTypes": {
        const chosen = filters.flatshareTypes.anyOf;
        return (
          <Disclosure
            quiet
            className="pf-fold"
            title={chosen.length === 0 ? "Choose kinds of WG" : `${chosen.length} kinds chosen`}
          >
            <ChipGroup
              hideLegend
              legend="Flatshare types"
              options={FLATSHARE_OPTIONS}
              chosen={chosen}
              onChange={(anyOf) => patch("flatshareTypes", { anyOf })}
            />
          </Disclosure>
        );
      }
      case "area":
        return (
          <ListField
            label="Districts or PLZ"
            placeholder="Neukölln, 10115"
            value={filters.area.anyOf}
            onChange={(anyOf) => patch("area", { anyOf })}
          />
        );
      case "flatmateAges":
        return (
          <div className="pf-pair">
            <NumberField
              integer
              label="From"
              spoken="Flatmate ages from"
              suffix="years"
              value={filters.flatmateAges.min}
              onChange={(min) => patch("flatmateAges", { min })}
            />
            <NumberField
              integer
              label="To"
              spoken="Flatmate ages to"
              suffix="years"
              value={filters.flatmateAges.max}
              onChange={(max) => patch("flatmateAges", { max })}
            />
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <div className="pf-groups">
      {GROUPS.map((group) => (
        <section key={group.title} aria-label={group.title} className="pf-group">
          <h3 className="pf-subtitle">{group.title}</h3>
          {group.keys.map((key) => row(key, settings(key)))}
        </section>
      ))}
    </div>
  );
}

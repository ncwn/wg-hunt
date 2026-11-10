import type { Category, RentType } from "../searches.js";
import { defaultFilters, type Filters } from "./filters.js";
import { defaultSeekerProfile, type SeekerProfile } from "./profile.js";

type ExampleSearch = {
  city: string;
  categories: Category[];
  rentTypes: RentType[];
  priceCeiling: number;
  recencyDays: number;
};

export type ExamplePreset = { profile: SeekerProfile; filters: Filters; search: ExampleSearch };

const pad = (n: number) => String(n).padStart(2, "0");

/** A made-up seeker, never a real one. */
export function examplePreset(today: { year: number; month: number }): ExamplePreset {
  const index = today.year * 12 + (today.month - 1) + 2;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const window = `${year}-${pad(month)}`;

  const filters = defaultFilters();
  filters.maxRent = {
    enabled: true,
    strength: "dealbreaker",
    limit: 700,
    margin: { value: 50, unit: "absolute" },
  };
  filters.minSize = { enabled: true, strength: "want", limit: 12, margin: null };
  filters.distance = { enabled: true, strength: "want", place: "work", limit: 5, margin: null };

  return {
    profile: {
      ...defaultSeekerProfile(),
      gender: "woman",
      age: 27,
      anmeldungNeeded: true,
      moveIn: { earliest: `${window}-01`, latest: `${window}-15` },
      stay: { minMonths: 12, maxMonths: null },
      diet: "vegetarian",
      occupation: "working",
      smoker: false,
      hasPets: false,
      languages: ["de", "en"],
      // A central Berlin PLZ.
      places: [{ name: "work", plz: "10115" }],
    },
    filters,
    search: {
      city: "Berlin",
      categories: ["flatshare-room", "one-room-flat"],
      rentTypes: ["unlimited"],
      priceCeiling: 800,
      recencyDays: 7,
    },
  };
}

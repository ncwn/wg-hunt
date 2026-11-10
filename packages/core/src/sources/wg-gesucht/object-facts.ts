import type { RuleFacts } from "../../offer-facts/index.js";
import { field, unknown } from "./build.js";
import { clean } from "./german.js";
import { AMENITY_LABELS } from "./lexicon.js";
import type { Page } from "./page.js";

/** "Angaben zum Objekt": icon-keyed items. The icon class is the key; the text is the value. */
function readIcons(page: Page): Map<string, string> {
  const { $ } = page;
  const icons = new Map<string, string>();
  $(".utility_icons div.text-center").each((_, item) => {
    const copy = $(item).clone();
    // The energy certificate item carries a long legal blurb in a popover.
    copy.find('[id^="popover"], .popover').remove();
    const icon = (copy.find("span.mdi").first().attr("class") ?? "")
      .split(/\s+/)
      .find((name) => name.startsWith("mdi-") && name !== "mdi-42px" && name !== "mdi-success");
    const text = clean(copy.text());
    if (icon && text !== "" && !icons.has(icon)) icons.set(icon, text);
  });
  return icons;
}

const items = (text: string): string[] =>
  text
    .split(",")
    .map(clean)
    .filter((item) => item !== "");

const LIST_ICONS = {
  kitchen: "mdi-silverware-fork-knife",
  bathroom: "mdi-shower",
  internet: "mdi-wifi",
  tv: "mdi-monitor",
  flooring: "mdi-layers",
  heating: "mdi-fire",
  parking: "mdi-car",
} as const;

const FLAG_ICONS = {
  accessible: "mdi-wheelchair-accessibility",
  offeredAsWg: "mdi-account-group-outline",
  greenElectricity: "mdi-leaf",
} as const;

export function objectFacts(page: Page): Partial<RuleFacts> {
  const icons = readIcons(page);
  const facts: Partial<RuleFacts> = {};

  for (const [key, icon] of Object.entries(LIST_ICONS)) {
    const text = icons.get(icon);
    facts[key as keyof typeof LIST_ICONS] = text ? field(items(text), text) : unknown();
  }
  for (const [key, icon] of Object.entries(FLAG_ICONS)) {
    const text = icons.get(icon);
    facts[key as keyof typeof FLAG_ICONS] = text ? field(true, text) : unknown();
  }

  const building = icons.get("mdi-city");
  facts.buildingType = building ? field(building, building) : unknown();
  const floor = icons.get("mdi-office-building");
  facts.floor = floor ? field(floor, floor) : unknown();

  const furnishing = icons.get("mdi-bed-double-outline");
  facts.furnished = unknown(furnishing ?? "");
  if (furnishing) {
    const lowered = furnishing.toLowerCase();
    if (/teilmöbliert/.test(lowered)) facts.furnished = field("partly_furnished", furnishing);
    else if (/unmöbliert|nicht möbliert/.test(lowered))
      facts.furnished = field("unfurnished", furnishing);
    else if (/möbliert/.test(lowered)) facts.furnished = field("furnished", furnishing);
  }

  const transit = icons.get("mdi-bus");
  const minutes = transit?.match(/(\d+)\s*Minuten/)?.[1];
  facts.transitMinutes = transit && minutes ? field(Number(minutes), transit) : unknown();

  const misc = icons.get("mdi-plus-circle-outline");
  facts.amenities = unknown();
  facts.petsAllowed = unknown();
  if (misc) {
    const listed = items(misc);
    const amenities = listed.flatMap((item) => AMENITY_LABELS[item.toLowerCase()] ?? []);
    facts.amenities = field(amenities, misc);
    const pets = listed.find((item) => item.toLowerCase() === "haustiere erlaubt");
    if (pets) facts.petsAllowed = field(true, pets);
  }

  const energy = icons.get("mdi-lightbulb-on-outline");
  facts.energyCertificate = energy ? energyCertificate(energy) : unknown();
  return facts;
}

function energyCertificate(text: string): NonNullable<RuleFacts["energyCertificate"]> {
  const value: {
    type?: "consumption" | "demand";
    energyValue?: string;
    energySource?: string;
    buildYear?: number;
    efficiencyClass?: string;
  } = {};
  for (const item of items(text)) {
    if (/^Verbrauchsausweis$/i.test(item)) value.type = "consumption";
    else if (/^Bedarfsausweis$/i.test(item)) value.type = "demand";
    else if (/^[VB]:/.test(item)) value.energyValue = item.replace(/^[VB]:\s*/, "");
    else if (/^Baujahr\s+\d{4}$/i.test(item)) value.buildYear = Number(item.slice(-4));
    else if (/^Energieeffizienzklasse\s+/i.test(item)) {
      value.efficiencyClass = item.replace(/^Energieeffizienzklasse\s+/i, "");
    } else value.energySource = item;
  }
  return field(value, text);
}

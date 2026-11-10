import type { components } from "./api/schema.js";

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function table(
  header: string[],
  rows: string[][],
  right: ReadonlySet<number> = new Set(),
): string {
  const all = [header, ...rows];
  const widths = header.map((_, col) => Math.max(...all.map((row) => (row[col] ?? "").length)));
  const line = (row: string[]) =>
    row
      .map((cell, col) =>
        right.has(col) ? cell.padStart(widths[col] ?? 0) : cell.padEnd(widths[col] ?? 0),
      )
      .join("  ")
      .trimEnd();
  return all.map(line).join("\n");
}

export function pairs(entries: [string, string | number | boolean | null | undefined][]): string {
  const shown = entries.filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  const width = Math.max(0, ...shown.map(([label]) => label.length));
  return shown.map(([label, value]) => `${`${label}:`.padEnd(width + 1)} ${value}`).join("\n");
}

export function section(title: string, body: string): string {
  const indented = body
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
  return `${title}\n${indented}`;
}

export function euro(amount: number): string {
  return `€${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

export function inline(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function describe(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}-`;
    if (value.every((item) => !isPlain(item) && !Array.isArray(item))) {
      return `${pad}${value.map(inline).join(", ")}`;
    }
    return value
      .map((item) => {
        const body = describe(item, indent + 2).trimStart();
        return `${pad}- ${body}`;
      })
      .join("\n");
  }
  if (isPlain(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}-`;
    return entries
      .map(([key, item]) => {
        const nested = Array.isArray(item)
          ? item.length > 0 && item.some((x) => isPlain(x))
          : isPlain(item);
        if (nested && (!isPlain(item) || Object.keys(item).length > 0)) {
          return `${pad}${key}:\n${describe(item, indent + 2)}`;
        }
        return `${pad}${key}: ${describe(item, 0)}`;
      })
      .join("\n");
  }
  return `${pad}${inline(value)}`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "-";
  return iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "Z");
}

type SettingsState = components["schemas"]["SettingsState"];

/** Nothing for saved settings, or for an older server that does not say. */
export function settingsStateText(
  state: SettingsState | undefined,
  document: "analysis" | "crawl",
): string | undefined {
  if (state === undefined || state.source === "saved") return undefined;
  if (state.source === "default") return "default: nothing is saved, so the defaults are in use";
  const back =
    state.unreadable.length === 1 ? "is back at its default" : "are back at their default";
  const file = `${document}.json`;
  return `${state.source}: ${state.unreadable.join(", ")} ${back}. Saving the settings ends this: \`wg-hunt settings ${document} show --json > ${file}\`, check it, then \`wg-hunt settings ${document} set --file ${file}\`.`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 1024 to the unit, at most one decimal. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(value) : String(Math.round(value * 10) / 10);
  return `${rounded} ${UNITS[unit]}`;
}

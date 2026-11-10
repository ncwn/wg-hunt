/** The error's class and, when it has one, its code: never its message, which may quote a page. */
export function errorKind(err: unknown): string {
  const name = err instanceof Error ? err.name : "error";
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? `${name} (${code})` : name;
}

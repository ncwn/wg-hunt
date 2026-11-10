import { isIPv4, Socket } from "node:net";
import { afterAll, afterEach } from "vitest";

type Target = { host?: string | undefined; port?: unknown; path?: unknown };
type Connect = Socket["connect"];
type Guarded = Connect & { [STATE]: { attempts: string[] } };

const STATE = Symbol.for("wg-hunt.no-network");

export function isThisMachine(host: string | undefined): boolean {
  if (host === undefined || host === "") return true;
  const name = host.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1" || name === "[::1]") return true;
  return isIPv4(name) && name.startsWith("127.");
}

function isSocketFile(path: unknown): boolean {
  return typeof path === "string" && path !== "";
}

function targetOf(args: unknown[]): Target {
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (typeof first === "object" && first !== null) return first as Target;
  if (typeof first === "string" && Number.isNaN(Number(first))) return { path: first };
  return { port: first, host: typeof second === "string" ? second : undefined };
}

function message(where: string): string {
  return `No network in tests: a test opened a connection to ${where}. The Source and the model provider are fakes (CONTRIBUTING.md).`;
}

function install(): { attempts: string[] } {
  // Under `isolate: false` or a vm pool, test files share builtins and so one wrapper.
  const current = Socket.prototype.connect as Partial<Guarded>;
  if (current[STATE]) return current[STATE];
  const original = Socket.prototype.connect;
  const state = { attempts: [] as string[] };
  const guarded = function (this: Socket, ...args: unknown[]) {
    const target = targetOf(args);
    if (!isSocketFile(target.path) && !isThisMachine(target.host)) {
      const where = `${target.host}:${String(target.port)}`;
      state.attempts.push(where);
      throw new Error(message(where));
    }
    return Reflect.apply(original, this, args);
  } as Guarded;
  guarded[STATE] = state;
  Socket.prototype.connect = guarded;
  return state;
}

const { attempts } = install();

export function takeAttempts(): string[] {
  return attempts.splice(0);
}

export function failOnAttempts(): void {
  const seen = takeAttempts();
  if (seen.length > 0) throw new Error(message(seen.join(", ")));
}

afterEach(failOnAttempts);
afterAll(failOnAttempts);

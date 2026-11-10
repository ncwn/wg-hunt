import { homedir } from "node:os";
import type { Io } from "./io.js";
import { promptHidden } from "./prompt.js";
import { run } from "./run.js";

const controller = new AbortController();
const interrupt = () => {
  // `watch` ends cleanly on the signal. If anything else is still going, do not hang the shell.
  controller.abort();
  setTimeout(() => process.exit(130), 500).unref();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const io: Io = {
  env: process.env,
  fetch: (request) => fetch(request),
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: { isTTY: process.stdin.isTTY, read: readStdin },
  promptSecret: promptHidden,
  homeDir: homedir(),
  cwd: process.cwd(),
  now: Date.now,
  signal: controller.signal,
};

process.exitCode = await run(process.argv.slice(2), io);

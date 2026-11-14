import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OFFER_SUFFIX, PAIR_SUFFIX } from "./cases.js";

/** The only place in the repository evaluation data may live, relative to the project root. */
export const SYNTHETIC_DIR = "packages/eval/synthetic";

export function findProjectRoot(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return resolve(start);
  }
}

function filesGitSees(root: string): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return out.split("\0").filter((name) => name !== "");
}

const isEvalData = (file: string) => file.endsWith(OFFER_SUFFIX) || file.endsWith(PAIR_SUFFIX);

export function findStrayEvalData(
  root: string,
  list: (root: string) => string[] = filesGitSees,
): string[] {
  return list(root)
    .filter((file) => isEvalData(file) && !file.startsWith(`${SYNTHETIC_DIR}/`))
    .sort();
}

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
/** Invented contacts use a domain RFC 2606 reserves, which no one can own. */
const INVENTED_DOMAINS = /(^|\.)example\.(invalid|com|org|net)$|(^|\.)invalid$/i;
const PHONE = /(?:\+|\b00)\d[\d ()/-]{7,}\d|\b0\d{2,5}[ /-]\d{5,}\b/;
const URL = /https?:\/\/[^\s"'<>)]+/g;
/** The Source's own photo links: a host the fixtures already use, a made-up digest. */
const PHOTO_URL = /^https:\/\/img\.wg-gesucht\.de\/media\/up\/\d{4}\/\d{2}\/[0-9a-f]{64}_[\w.-]+$/;
const COORDINATES = /"lat"\s*:|"lng"\s*:/;

function problemsIn(name: string, content: string): string[] {
  const problems: string[] = [];
  if (name.endsWith(".html") && !content.includes("SYNTHETIC")) {
    problems.push(`${name}: a page must say it is synthetic (a "SYNTHETIC" comment)`);
  }
  if (name.endsWith(".json")) {
    const synthetic = (JSON.parse(content) as { synthetic?: boolean }).synthetic;
    if (synthetic !== true) problems.push(`${name}: a committed case must set "synthetic": true`);
  }
  for (const match of content.matchAll(EMAIL)) {
    if (!INVENTED_DOMAINS.test(match[1] ?? ""))
      problems.push(`${name}: an email address (${match[1]})`);
  }
  if (PHONE.test(content)) problems.push(`${name}: something that looks like a phone number`);
  for (const [url] of content.matchAll(URL)) {
    if (!PHOTO_URL.test(url))
      problems.push(`${name}: a web address that is not an invented photo link`);
  }
  if (COORDINATES.test(content)) problems.push(`${name}: coordinates`);
  return problems;
}

export function checkSyntheticSet(dir: string): string[] {
  const problems: string[] = [];
  for (const folder of ["offers", "pairs"]) {
    const path = join(dir, folder);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path).sort()) {
      if (!/\.(html|json)$/.test(name)) continue;
      problems.push(...problemsIn(`${folder}/${name}`, readFileSync(join(path, name), "utf8")));
    }
  }
  return problems;
}

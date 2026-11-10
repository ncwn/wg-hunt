#!/usr/bin/env node
// Exits non-zero unless the tag is exactly `v` followed by the root package.json's version, so
// a release never publishes an image or a CLI bundle that reports another version.
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.argv[2] ?? "";

if (tag !== `v${version}`) {
  console.error(
    `The tag "${tag}" does not match the root package.json version ${version}; expected v${version}.` +
      ` Bump the version, commit, and tag that commit v<version>.`,
  );
  process.exit(1);
}
console.log(`Tag ${tag} matches the root package.json version ${version}.`);

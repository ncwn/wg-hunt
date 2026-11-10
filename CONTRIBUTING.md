# Contributing

Open an issue for bugs and ideas. For a pull request, keep it to one change and make sure the checks below pass.

## Setup

You need Node 26 and pnpm.

```sh
pnpm install
pnpm dev             # the server with auto-reload, data in .data/
pnpm dev:dashboard   # the dashboard on Vite, proxied to the server
```

The server listens on `WG_HUNT_HOST` (default `127.0.0.1`) and `WG_HUNT_PORT` (default `8787`), and serves the dashboard build from `WG_HUNT_DASHBOARD_DIR` (default `apps/dashboard/dist`); the image sets all three.

After changing `apps/server/src/db/schema.ts`, run `pnpm --filter @wg-hunt/server db:generate` and commit the migration it writes to `apps/server/drizzle/`.

To run your own build in Docker instead of the published image:

```sh
docker build -t ghcr.io/ncwn/wg-hunt:dev .
WG_HUNT_VERSION=dev docker compose up -d --pull never wg-hunt   # skips the auto-updater
```

## Checks

```sh
pnpm lint    # Biome, knip (unused files, exports and dependencies) and the type check
pnpm test    # Vitest: unit, API and dashboard tests
pnpm build
```

CI runs all three and, alongside them, builds the image and smoke-tests it (`scripts/smoke-container.sh`): health, versions, and data surviving a restart.

Every workflow Action is pinned to a commit in `.github/workflows/actions.lock`. After changing a `uses:` line, run `gh actions-lock` (the [gh-actions-lock](https://github.com/github/gh-actions-lock) extension) and commit the updated lockfile.

## Layout

```text
apps/server      Hono API, crawler, scheduler, SQLite (Drizzle migrations in drizzle/)
apps/dashboard   React dashboard, served by the server
apps/cli         the wg-hunt CLI, built into one file
packages/core    parsing, analysis, dedupe and ranking, no I/O
packages/eval    accuracy checks for extraction and dedupe
```

The dashboard follows the [design system](docs/design-system/README.md). Read it before changing a screen.

Two rules that tests enforce:

- **No real Offers in git.** Test and eval data are invented and marked synthetic. Real pages stay in `.data/`, which is gitignored.
- **No network in tests.** The Source and the model are fakes, and a test that opens a connection to another machine from the test process fails.

## Comments

Comments say what the code cannot: a reason from outside it (how the Source serves a page, a browser or SQLite quirk), a unit, a trap for the next editor. They don't describe what the code does, doc comments included, or tell its history; that goes in the commit message, and so do issue and PR numbers.

## Evaluation

`pnpm eval` checks what the rules and the model get right over labelled Offers in `packages/eval/synthetic/`. By default it replays scripted model answers, so it needs no key and costs nothing. `pnpm test` runs it too.

```sh
pnpm eval --rules-only
ANTHROPIC_API_KEY=... pnpm eval --live --set all --save   # a real model, costs money
pnpm eval compare <first>.json <second>.json
```

When no Offer got a model answer (a refused key, an outage), the run says `model-failed` and exits 1; `--save` still keeps it.

To measure on your own rooms, put labelled cases in `.data/eval/offers/` (never committed). The easiest source is the facts you corrected by hand in the dashboard:

```sh
curl -H "Authorization: Bearer $(cat .data/access-token)" http://127.0.0.1:8787/api/v1/offers/overrides > overrides.json
pnpm eval export-overrides overrides.json
pnpm eval --live --set local
```

A case is a stored page `<id>.html` plus `<id>.offer.json` with the facts you expect. Copy one from `packages/eval/synthetic/offers/` to see the shape. `pnpm eval --help` lists the rest.

## Releasing

wg-hunt has one version: `version` in the root `package.json`.

```sh
git commit -am "Release 1.2.3"   # after bumping the version on main
git tag v1.2.3
git push origin main v1.2.3
```

The release workflow publishes nothing if the tag doesn't match the version, or if a check fails on the tagged commit. It runs the [checks](#checks) itself (lint, tests and build, from the same `.github/workflows/checks.yml` as CI), because the tag is pushed together with `main`, before CI has finished. Once both pass, it smoke-tests and publishes the multi-arch image to GHCR, and attaches `wg-hunt.mjs` to the GitHub release.

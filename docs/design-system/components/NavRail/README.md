# NavRail

The dark navigation rail on the left: four destinations with their names under the icons, and Settings at the bottom. On a phone the same five are the bottom bar's tabs. Sign out is not here but [in Settings](../../README.md#what-each-screen-shows).

- It takes no props. Its pages come from `src/nav.ts` (Overview, Offers, Searches, Profile, then Settings), and the one the route is on is active.
- Offers carries a count of new Offers ("999+" past that). Profile and Settings carry a dot while they hold an unsaved draft. News is a count, not a dot, so it means something.
- Labels stay visible under the icons — this is not a developer tool, and an unlabeled rail makes people guess.
- One indicator only: the active item's icon sits on a `rail-raised` tile and its label turns `rail-ink-strong`. No edge bar.

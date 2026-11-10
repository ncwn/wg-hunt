# OfferCard

One offer at a glance: its photos as a gallery, title and district, its band, how its rent moved, the four facts that decide it with the small print under them, the reason chips, and the seeker's actions. Everything else is folded.

- `offer`: `{title, district, band, rent, size, moveIn, distance, photos, reasons, details, shortlisted, contacted, dismissed, url}`.
- Photos: the chosen one large (it opens every photo full size in a lightbox: arrows step, Esc closes), every photo beneath it as a thumbnail to choose. With none, a tinted tile stands in.
- `notes` sits under the title: on the Offers page, one Notice with why the Offer is hidden (its causes, a dealbreaker, a deactivated or deleted page) and how the ad is being read. `scam` fills an alarm Notice, "Might be a scam", under that.
- `history` sits above the facts: a compact RentChart titled "Rent history", its change pill saying how the rent moved ("Unchanged since 4 Nov").
- The four facts are warm rent, size, move-in and distance to work, as plain label and figure; a missing one reads "Not stated".
- `details` (`[{label, value}]` — posted, bumped, kind, and when they apply, costs not stated or a rent worked out from a nightly price) sit straight under the facts, always shown.
- `reasons` renders a ReasonList; `fit` (what the ad asks of whoever moves in) sits right under it.
- Actions are an even two-column grid: Open on wg-gesucht (primary, when there is a `url`), and Shortlist, Mark contacted and Not for me (secondary, pressed when on), each shown when its handler is given; `busy` disables them while a change is sent. `children` go under the actions: on the Offers page, Recheck and Re-analyse as two equal soft small buttons, then the folds.

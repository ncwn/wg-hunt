# ReasonList

How an offer fits, as short chips: concerns first, then what fits.

- `reasons`: `[{outcome: 'pass' | 'warn' | 'fail', text, quote?}]`. Chips are tinted by outcome — `rose` doesn't fit, `butter` check, `mint` fits — and sorted in that order. Screen readers hear "Doesn't fit:", "Check:" or "Fits:" before each. `label` names the group ("How it fits you" by default).
- `text` names what the chip is about in a few words, and the tint says how it went ([principle 7](../../README.md#principles)): the Filter on the OfferCard's reasons ("Move-in date", "Anmeldung"), the ask itself on what the ad asks for ("Requires students").
- Leave out what's already on screen. The OfferCard already shows rent, size and distance, so a reason about rent, size, rent per m² or distance appears only when it's a concern.
- A chip with a `quote` gets a chevron and opens the advertiser's words ("In the ad") underneath.

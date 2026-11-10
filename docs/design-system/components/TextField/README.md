# TextField

A labelled text input with an optional prefix ("€") or suffix ("m²", "days") and one line of help.

- Props: `label`, `prefix`, `suffix`, `hint`, `error`, plus any `<input>` attribute.
- Labels ask in the seeker's words: "Most you'll pay, warm", "Districts or PLZ" — not "priceCeiling" or "area".
- `error` replaces the hint and says how to fix it: "Enter a whole number of euros, or leave it empty".
- The focus ring goes around the whole box, not the bare input.

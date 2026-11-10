# IconButton

A round 40px button holding one Icon (44px on a phone and in the photo viewer), for closing a panel and stepping through photos.

- Provide `icon` and `label` — the label is the accessible name and the tooltip, so write it as words: "Close photos", "Next photo".
- `tone="plain"` drops the `surface-sunken` fill for use inside cards. Any other button attribute passes through.
- Use for at most three tools in a row. Anything that needs explaining gets a Button with words instead.

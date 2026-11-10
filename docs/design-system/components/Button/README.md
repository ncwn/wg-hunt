# Button

Pill-shaped buttons; **primary** (ink fill) at most once per view, for the thing the screen is for.

- `variant`: `primary` (the one main action — "Open on wg-gesucht"), `secondary` (outlined, `line-strong` border on `surface` — "Shortlist", "Not for me"; the default), `soft` (`sky-soft` fill — "Recheck", "Re-analyse"), `ghost` (text only — "Cancel", "Discard" or "Revert" beside a primary, nothing else), `bright` (only on the dark StatusCard), `danger` (`warned` fill, for the answer that deletes or signs out; [States and motion](../../README.md#states-and-motion) says when).
- Every action the seeker might take has a visible edge at rest. Don't use `ghost` for a real choice like "Not for me": it disappears into the panel until hovered.
- `size`: `sm` 32px, `md` 40px (default), `lg` 48px. `icon` takes an Icon name, for the few buttons [Iconography](../../README.md#iconography) gives one. Any other button attribute passes through.
- `LinkButton` is a link that looks like a button: `href`, `variant`, and `external` to open in a new tab with the ↗ icon after the label.
- Labels follow [Voice and copy](../../README.md#voice-and-copy).

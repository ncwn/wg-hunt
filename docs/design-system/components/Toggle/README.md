# Toggle

An on/off switch for a setting that takes effect immediately.

- Pass `checked` and `onChange`; it holds no state of its own. Always pass `label` (its accessible name). `disabled` holds it while the setting can't change yet.
- On is an `ink` track with a `surface` knob; off is `surface-sunken` with a `line-strong` border, so the state reads without colour.
- Sits at the right of a SettingRow. Never use a Toggle for something that needs a Save button.

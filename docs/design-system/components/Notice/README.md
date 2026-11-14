# Notice

A one-line message with its tone in the border: a likely scam, a Search that finds nothing, offers still being read.

- `tone` sets only the border colour ([Colour](../../README.md#colour) says why): `alarm` (`notice-alarm-line` — scams, anything that could cost money), `warn` (`notice-warn-line`), `info` (`notice-info-line`). The fill stays `surface`; an alarm's title is `warned`.
- `title` is the one line that's always visible. Give `children` and the Notice folds: it gets a chevron and opens to the explanation underneath. `defaultOpen`, or `open` + `onToggle`.
- No buttons inside, and the Notice takes none, except the scam Notice on an Offer, which opens to the scam marks' buttons. If something needs doing, the explanation says where, or the page around it has the control beside the Notice.
- `onDismiss` adds a small ✕ for notices that are only news. `role` is `alert` for `alarm` and `status` otherwise; pass `null` when the page around it already announces.
- At most one Notice per screen region.

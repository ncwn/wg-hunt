# StatusPill

Whether wg-hunt is out looking for rooms, as a dot and one word. Nothing else is shown until it's asked for.

- `state` and its word: `running` "Hunting" (green dot), `paused` "Paused", `resting` "Resting" (quiet hours), `cooldown` "Taking a break" (red dot), `needs-you` "Needs you" (red dot). These are the hunt words everywhere.
- Children are the detail ("Next check at 14:20", "Back at 14:20"). It appears only as a tooltip on hover or keyboard focus, and is the pill's accessible description.
- `onDark` is the version used inside the StatusCard.
- It sits in the top bar on every page — the only crawl information the main screens show.

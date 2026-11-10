# StatusCard

The dark card that says whether wg-hunt is looking for rooms right now — and offers the one action that helps.

- `state` matches [StatusPill](../StatusPill/README.md) and sets the title ("Hunting is on", "Taking a short break"). Children are one short sentence in plain time ("Next check at 14:20.").
- `action` is the button's label, "Pause" or "Resume", or `false` for none; `onAction` runs it and `busy` disables it. The page picks it from what the server allows: Resume when hunting can resume, Pause whenever hunting isn't paused (quiet hours and breaks too), and nothing while a paused hunt is also on a break or offer data is being deleted — the sentence says when it goes on.

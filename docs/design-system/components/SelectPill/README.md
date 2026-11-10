# SelectPill

A compact pill that opens a menu — "Sort Best fit ▾" — for choosing a view without leaving the page.

- `value`, `options` (`[{value, label}]`) and `onChange`; an optional muted `label` before the value, and `aria-label` when that label alone doesn't name it.
- The pill opens its own menu: the arrow keys move, typing jumps to a label, Enter chooses, Esc closes. On a phone the menu opens over a scrim.
- Name sorts in plain words, as [Voice and copy](../../README.md#voice-and-copy) lists them.

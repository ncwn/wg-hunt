# Segmented

Two to four mutually exclusive choices shown at once, such as which offers to list or a chart's time range.

- `options`: `[{value, label}]`, with `value` and `onChange`. It holds no choice of its own.
- `quiet` is the borderless version used inside the RentChart card. `disabled` holds every option while the choice can't change yet.
- `label` names the group for screen readers.
- More than four options, or options longer than two words: use a SelectPill.

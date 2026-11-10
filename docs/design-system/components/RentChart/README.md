# RentChart

The sky card with the typical warm rent of the seeker's matches and how it moved over time.

- `points` (numbers, oldest first) and `labels` (each point's day, for the tooltip; in "All" past 120 days a point is a week). `slots` sets how many points the line spans, so a short history starts partway along. The headline is the last point.
- `change` is the pill beside the headline ("−€ 43 in 30 days"). `ranges`, `range` and `onRange` add a quiet [Segmented](../Segmented/README.md) under the line. `empty` says why there's nothing to draw ("No matches with a rent yet").
- `title` names the line for screen readers. `compact` shows the title in place of the headline, as the OfferCard's rent history does.
- Drag along the line, or use the arrow keys, to read any point's rent in the tooltip.
- The headline is a median, rounded to whole euros. Say "typical", not "median".
- One line, one series. Comparisons belong in their own card.

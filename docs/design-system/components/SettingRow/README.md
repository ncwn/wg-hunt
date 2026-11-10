# SettingRow

One setting as a row: a bold title, a few words on what it does when the title isn't enough, and its control at the right.

- Props: `title`, `description`, and `control` (a Toggle, SelectPill, Segmented, TextField or small Button). `layout="field"` gives the control a column up to 340px wide, for a field or a select, as the Profile's questions use.
- Rows stack inside a card under a section heading; rows after the first get a `line` divider.
- The description says what changes for the seeker, never how it works inside ("No checks between these times", not "Cron window for the crawl scheduler").
- A setting only troubleshooting needs goes behind Advanced ([principle 5](../../README.md#principles)).

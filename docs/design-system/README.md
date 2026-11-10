wg-hunt finds rooms in flatshares for one person and tells them which ones fit. The dashboard is for that person, not for whoever runs the server. Every screen answers three questions, in this order: **what's new for me, does it fit, and what do I do next.** The look is soft and calm: pastel cards on a white sheet, set in one dark frame with the rail, round type, generous space.

## Principles

1. **Answers, not machinery.** Show the result of the work ("6 new rooms since you last looked"), never the work itself (request counts, job queues, analysis versions, model names, token spend per call).
2. **One glance, one decision.** An offer row shows warm rent, size, move-in, its band, and its district and distance under the title. That's enough to decide whether to open it. Everything else waits on the offer's card.
3. **Plain words.** Talk the way a friend helping with a flat hunt would. No field names, no error codes, no jargon.
4. **Calm by default, loud only for money.** Colour is soft almost everywhere. The only strong red is for things that could cost the seeker money or a room: a likely scam, and hunting stopping because it needs them.
5. **Advanced is one click away, never in the way.** Logs, pacing, keys, model settings and stored data are folded into one "Advanced" Disclosure in Settings.
6. **Fold the rest.** Each surface shows what decides the next step and folds the rest behind a chevron: a Notice opens to explain itself, an offer's Facts and Retention (and its Scam check, unless it's a likely scam) sit in folds under its card, an ad's quote opens from its chip.
7. **Say it once, short.** The seeker knows what they asked for, so a reason chip names what it is about and its tint says how that went, without the comparison ([Voice and copy](#voice-and-copy) has examples). Don't repeat a fact that's already on screen, and don't add icons that only repeat a word.

## What each screen shows

| Screen | Shows | Moves out |
| --- | --- | --- |
| Overview | TopBar with the status, RentChart, three StatCards (Matches, Near matches, Shortlisted, each opening its Offers view), "New for you" in an OffersTable, StatusCard | The crawl strip's request counts, the spend meter |
| Offers | Segmented (Matches / Near matches / Shortlisted / All), SelectPill sort, OffersTable at full width, the chosen offer as an OfferCard in a SidePanel | Sorts named "Band, then …", per-row tags such as "Awaiting analysis" or "Not tracked" |
| Offer card | OfferCard (photos, the four facts and the details under them, ReasonList, actions, Recheck and Re-analyse), then folded Facts and Retention, and a folded Scam check unless the Offer is a likely scam, when the scam check sits in the card's alarm Notice instead. An old `/offer/:id` link opens it on Offers | The facts table as the first thing you see |
| Searches | One card per Search in plain words: "Rooms in Berlin up to € 700, posted in the last 3 days" | Pacing editor, upcoming jobs |
| Profile | The Seeker Profile and Filters as questions ("Do you need Anmeldung?") in full-width cards; once something changes, the draft preview with Save and Discard in a SidePanel | Filter keys and rule names, an "All saved" line |
| Settings | Full width: SettingRows for hunting, quiet hours, how often, monthly limit, scam hiding; one Advanced row; Sign out under "This browser" | Request log, analysis batches, secrets, data sizes on the main page; Sign out in the navigation |

## Voice and copy

- Address the seeker as **you**; wg-hunt speaks as itself ("wg-hunt stopped to be safe"), never as "we" or "the system".
- **Sentence case** everywhere, including buttons and titles. Verb-first buttons, two or three words.
- Numbers are what people say: "€ 590", "16 m²", "1 Dec", "14:20", "2.1 km to work". Rent is always **warm** rent unless it says otherwise.
- Keep the domain words people already use: Offer, Match, Near match, Shortlist, Anmeldung, WG. Keep the advertiser's quotes in their own language.
- No emoji, no exclamation marks, no "Oops".

| Say | Not |
| --- | --- |
| Hunting (on hover: Next check at 14:20) | Running · 212 requests today, 9 this hour |
| Resting (on hover: Resting until 07:00) | Outside active hours |
| Taking a break (on hover: Back at 14:20) | Cooling down until 2026-11-07T14:20:00+01:00 |
| wg-gesucht asked twice today whether you're a person, so wg-hunt stopped to be safe. | Waiting for you: Bot check twice within 24 h |
| Best fit · Cheapest first · Best value per m² · Biggest first · Free soonest · Closest to work | Band, then recency · Band, then rent per m² |
| Reading the ad… | Awaiting analysis |
| Couldn't read this ad. Re-analyse to try again. | Analysis failed: 529 overloaded_error |
| Doesn't fit: Move-in date | Free from 1 Dec, you wanted mid-November |
| Requires students | Students only, and you're working |
| costs not stated (under the rent) | Nebenkosten unknown (costs-incomplete) |
| Monthly limit for reading offers | Spend cap (Anthropic API, USD) |

## Colour

- The page sits on `canvas`, which is the `rail`'s colour, so the rail and the ground read as one dark frame. The app is one `surface` sheet with `radius-xl` corners on it, and a side panel, when one is open, is a second sheet beside it. Text never sits straight on `canvas`.
- Body text is `ink`; secondary text is `ink-muted` on `surface` and `surface-sunken`. On a pastel card it's `ink-soft`, because `ink-muted` runs too light there.
- The four pastels each have one job. `lavender` counts Matches, `mint` counts Near matches and fills the Match tag, `butter` counts the Shortlist and fills the Near match tag, `sky-soft` is the rent chart, the spend meter, soft buttons, a pressed action and a fact row the seeker set by hand. Row thumbnails take turns with all four; nothing else uses them as decoration.
- Bands are told apart by their word, never by colour alone. [BandTag](components/BandTag/README.md) has each band's pair, and [ReasonList](components/ReasonList/README.md) the reason chips' three pastels.
- A [Notice](components/Notice/README.md) carries its tone in a 1px border, softened toward `surface`, and an alarm's title in `warned`, so a message never outshouts the content around it.
- `warned-solid` is for alarm dots only (cooldown, needs-you, the "New" dot). It never fills behind text.
- `sky` is the interactive colour: links, the chart line, the selected range, and the focus ring.
- Primary buttons are `ink` with `surface` text. In dark mode that flips to a light button with dark text, so it stays the strongest thing on screen.
- Both themes pass: text is at least 4.5:1 on the grounds its token's note names, and control borders (`line-strong`), icons and the focus ring are at least 3:1.

## Type

- One family: **Manrope**, weights 500–800, with tabular figures for every number in a column or on a card. It is self-hosted with `@fontsource-variable/manrope`, so the dashboard needs no outside requests.
- Sizes, line heights and weights, like the spacing scale below, are in [`tokens.json`](tokens.json). `display` is the page title, once per page. `title` titles sections ("Your hunt", "New for you"). `heading` is for card headings.
- `figure-lg` is a card's one headline number; `figure` is for facts in an OfferCard.
- `body` is the default. `body-strong` is for the value the eye should land on, usually the warm rent. `label` is for column headers and field labels, `caption` for meta lines.
- Nothing smaller than 12px except the nav badge's count and the "New" marker.

## Space, shape and depth

- Spacing runs on a 4px base, from `space-1` up to `space-10`. Cards are separated by `space-4`. Sections by `space-8`. The sheet's padding is `space-8`.
- Corners: `radius-sm` for tags and inputs, `radius-md` for thumbnails, menus, Notices and the rail's tiles, `radius-lg` for every card, `radius-xl` for the app sheet, `radius-pill` for buttons, pills and chips.
- Cards stand out by their fill, not by borders or shadows. `shadow-card` is a whisper. The sheet and the side panel are flat: on the dark `canvas` their fill is enough, and the same treatment keeps either from reading as on top of the other. `shadow-raised` is only for what floats: the StatusCard, menus, tooltips, the Confirm, the Offer panel's close button and the skip link.
- Layout: a 96px rail and a fluid sheet, both the screen's height. The sheet never grows with its page: its head (TopBar, then the hunt alarm) stays put and the page scrolls inside the sheet, on every screen size. On Offers the Segmented stays too, and only the list scrolls, under its column headers. A side panel is the same height, one gap from the sheet, and scrolls inside itself. On a phone it takes the sheet's place above the tab bar, the same card with the same X. It closes from its X, Esc, or the row that opened it: an Offer's row is a toggle. The Overview uses two rows, chart beside the stats, then table beside the StatusCard, as in OverviewPage. Cards that share a row share a height: section headings sit in 44px rows, and the stat cards stretch to the chart's top and bottom edges. At 1024px and narrower the rail slims to 80px and the Overview regroups into two columns; at 640px and narrower the rail becomes a bottom bar and the rows stack.

## States and motion

- Hover darkens a fill one step (`surface` → `surface-sunken`). Press nudges a button 1px down.
- Folds open in place with no animation of height. Only the chevron turns (150ms). Closed is the default unless the page exists to show that content. A fold opens from its whole row or strip: one button, with the chevron inside it.
- Secondary detail that's only sometimes wanted, like when wg-hunt last checked, waits in a tooltip on hover and focus.
- Focus is one ring everywhere: 2px solid `focus-ring`, offset 2px. Inside the rail and on the StatusCard it's `rail-focus-ring`.
- Disabled controls drop to 45% opacity and keep their label.
- Transitions are 150ms for colour and position. There are no animated entrances and no spinners where a sentence will do ("Reading the ad…"). Two exceptions: a SidePanel (an Offer's card, the Profile's draft preview) slides in from the right as the sheet narrows to make room (260ms), and out again when it goes; a Confirm question fades in with its scrim (180ms). With reduced motion they just appear.
- A SidePanel is for what belongs beside the page rather than on it: the chosen Offer, the unsaved changes. It appears only once there is something to show; the page is full width until then. Below 1025px a page decides where it goes instead (over the list for an Offer, above the cards for a draft).
- Anything sensitive asks first, in a Confirm that pops up over a scrim: signing out, deleting a search, clearing a key, rotating the token, throwing away a draft, spending money on a re-analysis. The question names the thing ("Sign out of wg-hunt?"), one line says what happens, and the answers are Cancel and a verb ("Sign out"), `danger` when it deletes or signs out. Esc, Cancel and the scrim all say no; focus goes back to the button that asked. Deleting every Offer asks more: the seeker types a phrase before "Delete everything" works. Something reversible in one click (Not for me, a shortlist star) doesn't ask.
- An empty state says what will happen, from the hunt's real state: "No matches yet. Next check at 14:20." (or "Hunting is paused until you resume it."). Never a blank table, and never a check that isn't coming.

## Iconography

- Icons come from the system's own [Icon](components/Icon/README.md) set, drawn for wg-hunt.
- Icons are for navigation, tools and the few buttons where they add meaning (↗ leaving for wg-gesucht, ★ Shortlist). Tags, stat cards, facts, Notices and reason chips have none — their words say it.
- A standalone icon is an [IconButton](components/IconButton/README.md).
- A chevron means "there's more here": `chevronDown` turns 180° when open; `chevronLeft` and `chevronRight` step through months and photos.

## Logo

- The mark is a house with a magnifying glass for a door, in `brand-ink` on the butter `brand` tile with `radius-md` corners. It's the same in both themes.
- The wordmark is the word "wg-hunt", always lowercase, set live in Manrope 800 beside the mark.
- [Logo](components/Logo/README.md) is the component, and [assets/Logos](assets/Logos/README.md) has the files.

## Building with it

- The components live in `apps/dashboard/src/ui` (NavRail and TopBar in `src/components`), styled by `src/styles/ui.css`, which reads only the tokens in `src/styles/tokens.css`. `tokens.json` here is the source of those values, and a test checks they match and pass contrast in both themes.
- Give components data already formatted for people, like "€ 590" or "1 Dec". They don't format or fetch anything, with these exceptions: RentChart takes plain numbers and writes them as euros, DateField takes an ISO date and writes it as "1 Dec", MonthField writes its own month names, and NavRail and TopBar read the counts and the hunt's status themselves.
- Each component has a page saying what it is for: [BandTag](components/BandTag/README.md), [Button](components/Button/README.md), [Disclosure](components/Disclosure/README.md), [Icon](components/Icon/README.md), [IconButton](components/IconButton/README.md), [Logo](components/Logo/README.md), [NavRail](components/NavRail/README.md), [Notice](components/Notice/README.md), [OfferCard](components/OfferCard/README.md), [OffersTable](components/OffersTable/README.md), [ReasonList](components/ReasonList/README.md), [RentChart](components/RentChart/README.md), [Segmented](components/Segmented/README.md), [SelectPill](components/SelectPill/README.md), [SettingRow](components/SettingRow/README.md), [StatCard](components/StatCard/README.md), [StatusCard](components/StatusCard/README.md), [StatusPill](components/StatusPill/README.md), [TextField](components/TextField/README.md), [Toggle](components/Toggle/README.md), [TopBar](components/TopBar/README.md). [OverviewPage](components/OverviewPage/README.md) and [SettingsPage](components/SettingsPage/README.md) are the layout references for those routes.
- A feature with no component here (fact overrides, retention, the request log) goes in one of the folds under the OfferCard or behind Settings › Advanced.

# OffersTable

The ranked offers as a calm table: a thumbnail and the title with its district and distance under it, then warm rent, size, move-in, the band and a shortlist star.

- `offers`: `[{id, title, district, distance, rent, rentNote, size, moveIn, band, isNew, shortlisted}]`, [already formatted](../../README.md#building-with-it). The columns are always Warm rent, Size, Move in and Fit; the distance reads "2.1 km to work" under the title.
- A row opens its Offer's card. The title is the link (`hrefFor`, by default `/offers?offer=<id>`) and the keyboard path. `onOpen` takes a plain click on it in place, while a click on the title with a modifier key or the middle button stays the browser's (a new tab, say). A click anywhere else on the row acts as the same click on its title: plain opens in place, and Cmd, Ctrl or the middle button opens a new tab. Shift and Alt there open nothing, since a script can't ask for a new window or a download as the browser does. `openId` marks the row whose card is open.
- `onShortlist` adds the Save column's star, which never opens the row.
- `rentNote` flags a rent the seeker can't trust yet ("costs not stated") under the price. `isNew` puts "New" beside the title.

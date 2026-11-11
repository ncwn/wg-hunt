/**
 * Generated from the server's /api/v1/openapi.json. Do not edit by hand: change the API, then run
 * `pnpm --filter @wg-hunt/cli generate:api`. A test fails while this file is out of date.
 */

export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The server is up */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            status: "ok";
                            version: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description This API's OpenAPI document */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            [key: string]: unknown;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Check that the request is authenticated; the dashboard uses it to decide on login */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The request carries a valid Bearer token or session cookie */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        /** Dashboard login: exchange the access token for a session cookie */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        token: string;
                    };
                };
            };
            responses: {
                /** @description Session cookie set */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `invalid-token`: Invalid access token */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        /**
         * Dashboard logout: end this session on the server and clear its cookie
         * @description With a session cookie, that session ends on the server, so a copy of the cookie stops working; other sessions keep working. With a Bearer token nothing is revoked.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Session ended and its cookie cleared */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/token/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Replace the access token. The new token is returned this once; the old one and every dashboard session stop working */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The new access token. A dashboard session that made the call is renewed for it; all others end. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            token: string;
                        };
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/crawl": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The crawl state, today's and this hour's counts, and the next due jobs */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The crawl status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CrawlStatus"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/crawl/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop after the request in flight, until Resume */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The crawl status after pausing */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CrawlStatus"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/crawl/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lift a Pause, a layout-changed, disk-full or wiped pause, or the Resume owed after two Bot checks
         * @description Refused with `bot-check-cooldown` while a Cooldown runs: neither Pause nor Resume cuts a Cooldown short. Refused with `wipe-running` while "Delete all Offer data" runs; it leaves the crawl paused as `wiped`, and the Resume after it starts a fresh backfill.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The crawl status after resuming */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CrawlStatus"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `bot-check-cooldown`: Bot check Cooldown in progress; `wipe-running`: Offer data is being deleted */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/settings/crawl": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Editable pacing and Recheck settings, with the read-only constants */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The saved settings, or the defaults. A saved field that no longer parses is shown at its default: `settings` on `GET /crawl` names it */
                200: {
                    headers: {
                        /** @description The document's revision. Send it back as `If-Match` with the next PUT. */
                        ETag: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CrawlSettingsWithConstants"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        /** Replace the editable settings; values outside the constants are refused */
        put: {
            parameters: {
                query?: never;
                header?: {
                    /** @description The `ETag` from when the document was read, quoted, weak (`W/"…"`) or bare. If it has changed since, the write is refused with `stale-revision` (412) and nothing is saved. Left out, the document is replaced whatever its revision. */
                    "if-match"?: string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["CrawlSettings"];
                };
            };
            responses: {
                /** @description The stored settings */
                200: {
                    headers: {
                        /** @description The document's revision. Send it back as `If-Match` with the next PUT. */
                        ETag: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CrawlSettingsWithConstants"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `stale-revision`: Changed since it was read */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/crawl/requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The request log, newest first */
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A page of the request log */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CrawlRequestPage"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-cursor`: Invalid cursor */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/crawl/forecast": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The budget forecast for the stored Searches and settings
         * @description Expected requests in a day: polls, Sweeps, new Offers and Stale confirmations, and what is left for Rechecks. Only Searches the crawler reads are charged: a disabled Search, or an enabled one the Source cannot read (its row's `problem` says why), costs nothing. If polls plus Sweeps would take more than half the daily cap, every poll interval is stretched evenly until they fit, and the forecast warns when polls drop below one per 2 h. For a day after a Cooldown the caps are halved, and the forecast is worked from the halved cap (`halfBudget` says until when).
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The forecast */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Forecast"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        /** The budget forecast for draft Searches and settings; saves nothing */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["ForecastDraft"];
                };
            };
            responses: {
                /** @description The forecast */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Forecast"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Live updates as server-sent events
         * @description Each message has an `event` type and JSON `data`. The stream starts with one `crawl-status-changed` message holding the current status, so a client that (re)connects needs no extra request.
         *     - `crawl-status-changed`: the status changed; the data is the `CrawlStatus` that `GET /crawl` returns. Sent at once after each request and Bot check, when the crawl pauses or resumes, around a wipe, and when the crawl settings are saved; when jobs are queued, once for all queued together and only if they change what the status shows. Whatever else changes it, time alone included (the Berlin day starting again, requests leaving the rolling hour, a job falling due or leaving the queue, a Cooldown, the active hours or the half-budget period ending), is sent when the crawl loop next compares the whole status with the last one sent, which it does at least every 30 s. Keep the latest as the current status; it may equal the one before.
         *     - `bot-check-cooldown`: a Bot check was detected and a Cooldown started; the data is a `BotCheckRecord` plus `cooldownUntil`, `level` and `needsResume`.
         *     - `offer-added`: a new Offer was stored, or split off another ("not the same room"); the data is the `OfferSummary` that `GET /offers` lists. A split-off Offer keeps the marks, band and `createdAt` of the Offer it left, so it is not new to the seeker.
         *     - `offer-merged`: an Offer was merged into another ("same room", or dedupe found a Duplicate); the data is `{offerId, mergedInto}`. Drop `offerId` and read `mergedInto` again; `GET /offers/{offerId}` answers `offer-merged` with the same pointer.
         *     - `offer-band-changed`: an Offer moved to another band; the data is `{offerId, band, previousBand, bandChangedAt}`. Read the Offer again for its reasons.
         *     - `analysis-progress`: an Offer's analysis status changed (`offerId`, `analysisState`, `status` as `analysisStatus` on the Offer) with `awaiting`, the number of Offers that will be read without anyone acting, and `spentUsd`, the month's spend. Sent when a call starts or ends, when a batch takes or settles the Offer's request, when a failure is recorded, when changed words reset the Offer's analysis, and when a page failure ends because the stored page of the Offer's current Ad ID reads again.
         *     - `analysis-run-progress`: a re-analysis run moved on (`runId`, `status`, `stopReason`, `done`, `applied`, `total`) with `spentUsd`, the month's spend.
         *     - `spend-cap-reached`: the spend cap's `state` left `ok` (or moved between `waiting-for-in-flight` and `reached`); the data is the `AnalysisSpend` that `GET /analysis` shows as `spend`. Model calls stop and new Offers stay `pending` until what is in flight settles, the next month (`resetsAt`) or a higher cap; crawling goes on.
         *     - `spend-cap-cleared`: the spend cap's `state` is back to `ok` and model calls go out again; the data is the `AnalysisSpend`.
         *     - `analysis-status-changed`: something every Offer's analysis status depends on changed: the Anthropic key was saved, cleared, refused or accepted again, the spend cap's `state` changed, the analysis settings were saved, or a re-analysis run started or finished. The data is the `AnalysisStatus` that `GET /analysis` returns, sent only when it differs from the last one sent. Keep the latest as the current analysis status, and read the listed Offers and any open Offer again, since their `analysisStatus` may have changed with it.
         *     - `events-missed`: the client fell behind and some events were dropped; the data is `{missed}`, how many. Each client has at most 100 messages waiting, this one included. A newer `crawl-status-changed` or `analysis-status-changed` replaces a waiting one of its type, and a newer `analysis-progress` replaces a waiting one for the same Offer (a `reading` one never replaces a settled one, so the new result is still announced); those are not counted as missed. Past the limit the oldest events go, never the waiting `crawl-status-changed`, and one `events-missed` message waits in their place, ahead of the events that survived. Treat it like a reconnect: read `GET /offers`, `GET /analysis` and any open Offer again.
         *     - `session-ended`: the credential that opened the stream stopped working; the data is `{reason}`, one of `signed-out` (this dashboard session logged out), `token-rotated` (the access token was replaced, which ends every session) or `expired` (the session went unused too long or reached its maximum age, or the token was replaced while the server was down). It is always the last message: the server closes the stream right after it. Reconnecting with the same credential gets 401; a dashboard that rotated the token itself reconnects with its renewed cookie.
         *     The credential is checked again before each message and keep-alive, and a logout or rotation closes the stream at once, so no event reaches a client after its credential ends. These checks do not renew a session: an open stream alone does not keep its session from expiring; other requests do.
         *     Later features add their own event types.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description An event stream */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/event-stream": string;
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/searches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the Searches, oldest first */
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A page of Searches */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SearchPage"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-cursor`: Invalid cursor */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        /** Create a Search */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["NewSearch"];
                };
            };
            responses: {
                /** @description The new Search */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Search"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/searches/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one Search */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The Search */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Search"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Delete a Search */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The Search is gone */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** Change a Search; only the fields sent change */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["SearchChanges"];
                };
            };
            responses: {
                /** @description The Search as changed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Search"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/searches/{id}/crawl-now": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Make the Search's poll due now
         * @description The poll still waits for the gap between requests, the hourly and daily caps, the active hours and any Cooldown, and never cuts a Cooldown short. The answer says when it will run.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The poll is queued */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CrawlNow"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `search-disabled`: Search is disabled; `unknown-city`: City not recognised */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the ranked Offers, band by band
         * @description Offers come in band order (Match, Near match, Warned, Hidden), each with its reasons, and inside a band in the chosen `sort`. Each Offer is in the band it was last ranked into: saving the Profile or Filters, a stored page, a mark or a fact correction re-band at once, and every Offer is ranked again every few minutes and after each Sweep, so a move that only time causes (such as going Stale) shows then. A read records a move that only time caused and announces it with `offer-band-changed`; it changes nothing else.
         */
        get: {
            parameters: {
                query?: {
                    /** @description The `nextCursor` of the previous page. It continues the list it came from: with another `sort`, or a distance sort to another Place, it is refused as `invalid-cursor`. */
                    cursor?: string;
                    limit?: number;
                    /** @description Only Offers that are new or entered their current band after this time (`createdAt` or `bandChangedAt`): what's new since a client last looked. */
                    since?: string;
                    category?: "flatshare-room" | "one-room-flat" | "flat" | "house";
                    /** @description Only this band. Without it the list holds Match, Near match and Warned; Hidden Offers are listed only with `band=hidden` or `includeHidden=true`. */
                    band?: components["schemas"]["Band"] & unknown;
                    /** @description The order inside each band. `recency` (the default) is the last Bump, else first seen, and a Near match puts its fewest misses before that. The others put Offers that lack the fact last. `distance` puts the nearest to a Place first (see `place`) and fills in each Offer's `distance`. */
                    sort?: "recency" | "warm-rent" | "rent-per-sqm" | "size" | "available-from" | "distance";
                    /** @description With `sort=distance`: the name of a Place of the Seeker Profile, whatever its case. The first Place when left out. Ignored for any other sort. */
                    place?: string;
                    /** @description Also list the Hidden band after the others. */
                    includeHidden?: "true" | "false";
                    /** @description Only the Offers the seeker shortlisted, from every band, Hidden too (or only `band`'s when it is given): the shortlist in one read. */
                    shortlisted?: "true" | "false";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A page of Offers */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["OfferPage"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-cursor`: Invalid cursor */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/counts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * How many Offers each band holds, and how many are new
         * @description The numbers the nav rail shows. `bands` counts what `GET /offers?band=` lists for each band (Stale, Untracked and Dismissed Offers are in Hidden); `new` counts the Offers that are not Hidden and are new since `since`.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Counts as `new` the Offers that are new or entered their current band after this time, as `since` does on the list. Without it every Offer that is not Hidden is new. */
                    since?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The counts */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["OfferCounts"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/overrides": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Every manual fact correction, as evaluation labels
         * @description Each correction with the Offer's current Source and Ad ID (`source`, `adId`), the page it was made on (`madeOn`), and how many Ad IDs the Offer has. This is the shape `pnpm eval export-overrides <file>` reads: save the `items` there to turn your corrections into labels of the local evaluation set. The export labels the page in `madeOn`; for a correction whose `madeOn` is null it labels the current page only when the Offer has one Ad ID.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The corrections */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FactOverrideList"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/lookup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Find the Offer known under a pasted URL or an Ad ID
         * @description Give either `url` or `adId` (with `source` when it is not wg-gesucht). An Ad ID wg-hunt has never stored as an Offer answers `not-known`.
         */
        get: {
            parameters: {
                query?: {
                    /** @description The address of an Offer page on a Source, as pasted from a browser. */
                    url?: string;
                    /** @description With `adId`: the Source the Ad ID belongs to. Defaults to `wg-gesucht`. */
                    source?: "wg-gesucht";
                    /** @description A bare Ad ID, as the Source numbers it. */
                    adId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The Offer, as `GET /offers/{id}` returns it */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Offer"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-known`: Not known */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one Offer with its facts, Ad IDs and photo addresses */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The Offer */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Offer"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found; `offer-merged`: Offer was merged into another */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/{id}/marks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Mark an Offer: dismissed, shortlisted, contacted, or a scam or not
         * @description Send only the marks to change; the others stay as they are. At least one is needed. `dismissed` hides the Offer at once and it stays hidden through re-posts; `shortlisted` and `contacted` are for display. `scam` makes the Offer a Likely scam (Warned) whatever its signals say; `not` makes it not one even with strong signals; `clear` takes the scam mark away so the computed verdict stands again. The Offer is ranked again at once.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["OfferMarksChange"];
                };
            };
            responses: {
                /** @description The Offer, with its marks and the band they put it in */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Offer"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found; `offer-merged`: Offer was merged into another */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/offers/{id}/facts/{fact}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Correct a fact by hand
         * @description Sets the fact's value with origin `manual`. It wins over the rules' and the model's reading, is never Doubtful, survives a re-analysis, a Recheck and a re-parse, and the Offer is ranked again at once. The reading it replaced stays in the fact's `alternatives`. `value` is the fact's value as `facts` shows it: `"possible"` for `anmeldung`, `{"amount": 550, "converted": false}` for a rent, `["woman"]` for `genderSought`, `"unknown"` to say the Offer does not say. A list fact (`requirements`, `scamSignals`) takes the list of its items' values, which may be empty.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                    /** @description The fact's name, as in `facts`: `anmeldung`, `warmRent`, `genderSought`, `requirements` and so on. Not `conflicts` or `imageUrls`. */
                    fact: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["FactOverride"];
                };
            };
            responses: {
                /** @description The Offer, with the fact corrected and the band it is now in */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Offer"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found; `offer-merged`: Offer was merged into another */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        post?: never;
        /**
         * Take a manual correction away
         * @description The rules' or the model's value is the fact's again, and the Offer is ranked again at once. A fact with no correction is left as it is.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                    /** @description The fact's name, as in `facts`: `anmeldung`, `warmRent`, `genderSought`, `requirements` and so on. Not `conflicts` or `imageUrls`. */
                    fact: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The Offer as it is now */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Offer"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found; `offer-merged`: Offer was merged into another */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/{id}/recheck": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Queue one Recheck of the Offer's page
         * @description Fetches the page of the Offer's most recently active Ad ID again, to catch edits or deactivation. It is queued at the lowest priority and keeps to the pacing and the caps. It runs even when automatic Rechecks are switched off. Only a Tracked Ad ID is crawled: when the current one is not, it is refused with `offer-untracked`, as `visibility.actions.recheck` says beforehand.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The Recheck is queued */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RecheckQueued"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found; `offer-merged`: Offer was merged into another */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `offer-untracked`: Offer is not Tracked */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/{id}/merge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Say another Offer is the same room as this one
         * @description Every Ad ID of `offerId` joins this Offer, which keeps its id; the other Offer is gone. The verdict is kept: later dedupe passes never split the two apart. A 404 is about the first of the two ids that has no Offer, the one in the address before `offerId`, and its `detail` names it: `offer-merged` when a merge absorbed that Offer, else `not-found`. An `offer-merged` whose `mergedInto` is this Offer's id says the two are one room already.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description The Offer to fold into this one. */
                        offerId: number;
                    };
                };
            };
            responses: {
                /** @description The merged Offer */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Offer"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found; `offer-merged`: Offer was merged into another */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/{id}/split": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Say an Ad ID is not the same room as the rest of this Offer
         * @description The Ad ID becomes an Offer of its own, with its price points. The verdict is kept: later dedupe passes never join it to this Offer again.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description The Ad ID to take out of the Offer. */
                        adId: string;
                        /**
                         * @description The Ad ID's Source. Defaults to `wg-gesucht`.
                         * @enum {string}
                         */
                        source?: "wg-gesucht";
                    };
                };
            };
            responses: {
                /** @description The new Offer made of the Ad ID */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Offer"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found; `offer-merged`: Offer was merged into another */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `offer-has-one-ad`: Offer has only one Ad ID */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/{id}/retention/release": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Let the record expire despite its merge and split verdicts
         * @description Same-room and not-the-same-room verdicts keep an Offer's record (`retention.keptBecause` has `pair-override`). This releases that pin for the verdicts given so far: the record ages like any other quiet Offer's, unless a mark or fact override keeps it. The verdicts stay, so the merge or split is not undone, and the other Offer of a split keeps its own pin. A verdict given later pins the record again. Releasing an Offer with no such pin changes nothing.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The Offer, with its `retention` as it stands now */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Offer"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found; `offer-merged`: Offer was merged into another */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/offers/{id}/reanalyze": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run the model pass on one Offer again
         * @description Queues the model pass for the Offer, whatever its state. Its previous result stays current until the new one succeeds. Progress arrives as `analysis-progress` events. Refused with `api-key-refused` while the API refuses the key that is set (`key: refused` on `GET /analysis`), and with `analysis-in-batch` while the Offer's request waits for, or is inside, a batch: that request is already paid for, and its result arrives when the batch ends. When what is left of the spend cap pays for the Offer's call as a batch and not in realtime, the click is sent as a batch: the Offer reads `in-batch`, and its result arrives when the batch ends. A click the spend cap stops after the `202` is kept, reads `waiting-for-cap`, and is read once there is room.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The analysis is queued */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReanalyzeAccepted"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found; `offer-merged`: Offer was merged into another */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `no-api-key`: No Anthropic API key is set; `api-key-refused`: The Anthropic API refused the key that is set; `analysis-in-batch`: Offer is already being read in a batch; `spend-cap-reached`: Spend cap reached */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The Seeker Profile (the neutral defaults on a fresh install) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The Seeker Profile */
                200: {
                    headers: {
                        /** @description The document's revision. Send it back as `If-Match` with the next PUT. */
                        ETag: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SeekerProfile"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        /**
         * Replace the Seeker Profile and rank every Offer again
         * @description Costs no crawling and no model call: the Offers are ranked again at once, and `offer-band-changed` is emitted for each that moved. A Profile that drops or renames the Place the saved distance Filter measures from is refused at `places`; save both with `PUT /seeking` instead.
         */
        put: {
            parameters: {
                query?: never;
                header?: {
                    /** @description The `ETag` from when the document was read, quoted, weak (`W/"…"`) or bare. If it has changed since, the write is refused with `stale-revision` (412) and nothing is saved. Left out, the document is replaced whatever its revision. */
                    "if-match"?: string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["SeekerProfile"];
                };
            };
            responses: {
                /** @description The Seeker Profile */
                200: {
                    headers: {
                        /** @description The document's revision. Send it back as `If-Match` with the next PUT. */
                        ETag: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SeekerProfile"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `stale-revision`: Changed since it was read */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/filters": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The active Filter set (the neutral defaults on a fresh install) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The Filters */
                200: {
                    headers: {
                        /** @description The document's revision. Send it back as `If-Match` with the next PUT. */
                        ETag: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Filters"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        /**
         * Replace the Filter set and rank every Offer again
         * @description Costs no crawling and no model call: the Offers are ranked again at once, and `offer-band-changed` is emitted for each that moved.
         */
        put: {
            parameters: {
                query?: never;
                header?: {
                    /** @description The `ETag` from when the document was read, quoted, weak (`W/"…"`) or bare. If it has changed since, the write is refused with `stale-revision` (412) and nothing is saved. Left out, the document is replaced whatever its revision. */
                    "if-match"?: string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["Filters"];
                };
            };
            responses: {
                /** @description The Filters */
                200: {
                    headers: {
                        /** @description The document's revision. Send it back as `If-Match` with the next PUT. */
                        ETag: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Filters"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `stale-revision`: Changed since it was read */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/seeking": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Replace the Seeker Profile, the Filter set or both in one write, and rank every Offer again
         * @description Both revisions are checked and the pair is validated before anything is written: a Place the distance Filter names must be in the resulting Profile. Then both are written together and the Offers are ranked again once, so an Offer that ends in the band it started in gets no `offer-band-changed`. This is how a Place the distance Filter measures from is renamed or removed. Costs no crawling and no model call.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["SeekingChanges"];
                };
            };
            responses: {
                /** @description Both documents as saved now */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Seeking"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `stale-revision`: Changed since it was read */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ranking/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Which Offers would change band under a draft Profile and Filters
         * @description Saves nothing of the draft and makes no request to the Source or a model. `before` is ranked as `GET /offers/counts` is: a move that only time caused is recorded and announced with `offer-band-changed` first.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["RankingPreviewRequest"];
                };
            };
            responses: {
                /** @description The band changes */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RankingPreview"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/presets/example": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The fictional example preset, as a draft
         * @description Never applies itself and saves nothing: the client shows it as a draft, and the seeker saves the Profile and the Filters together (`PUT /seeking`), and then the Search. The move-in window is the 1st to the 15th of the month two months after today (Europe/Berlin).
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The example preset */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ExamplePreset"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/secrets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Which secrets are set, each as a masked hint. Values are never returned */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description One entry per secret wg-hunt keeps */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Secret"][];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/secrets/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set or replace a secret. The value is write-only
         * @description Saving the Anthropic key, the same value included, ends a refusal (`key: refused` on `GET /analysis`): the key is tried again.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    name: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        value: string;
                    };
                };
            };
            responses: {
                /** @description The secret is set; this is its masked hint */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Secret"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        post?: never;
        /** Clear a secret; clearing one that is not set is not an error */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    name: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The secret is not set */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/settings/analysis": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Model and effort for the analysis and escalation passes, spend cap and price table */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The saved settings, or the defaults. A saved field that no longer parses is shown at its default: `settings` on `GET /analysis` names it */
                200: {
                    headers: {
                        /** @description The document's revision. Send it back as `If-Match` with the next PUT. */
                        ETag: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AnalysisSettings"];
                    };
                };
            };
        };
        /** Replace the analysis settings. Each model must be in the price table, with an effort it supports */
        put: {
            parameters: {
                query?: never;
                header?: {
                    /** @description The `ETag` from when the document was read, quoted, weak (`W/"…"`) or bare. If it has changed since, the write is refused with `stale-revision` (412) and nothing is saved. Left out, the document is replaced whatever its revision. */
                    "if-match"?: string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AnalysisSettings"];
                };
            };
            responses: {
                /** @description The settings as saved */
                200: {
                    headers: {
                        /** @description The document's revision. Send it back as `If-Match` with the next PUT. */
                        ETag: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AnalysisSettings"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `stale-revision`: Changed since it was read */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/analysis": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Analysis state: pending, analysed and failed Offers, how many are in each analysis status, whether a key is set or refused, Offers on an older analysis version with a cost estimate, and spend against the cap */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The analysis status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AnalysisStatus"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/analysis/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-analyse the Offers on an older analysis, as a batch
         * @description The only way a re-analysis run starts. It reads every non-Stale Offer whose result is on an older analysis version again through the Message Batches API, and answers `202` with the run. The previous result of each Offer stays current until its new one succeeds; a failed request leaves it. Refused with `api-key-refused` while the API refuses the key that is set (`key: refused` on `GET /analysis`), with `spend-cap-reached` when the cap is spent, and with `nothing-to-reanalyze` when no Offer is on an older analysis (`olderVersion.count` on `GET /analysis` is 0). The run stops sending (status `stopped`) if the cap runs out before every request is out. Progress arrives as `analysis-run-progress` events, or poll `GET /analysis/runs/{id}`.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The run was started */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AnalysisRun"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `no-api-key`: No Anthropic API key is set; `api-key-refused`: The Anthropic API refused the key that is set; `spend-cap-reached`: Spend cap reached; `analysis-run-active`: A re-analysis run is already going; `nothing-to-reanalyze`: No Offer is on an older analysis */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/analysis/runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A re-analysis run and how far it has got */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The run */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AnalysisRun"];
                    };
                };
                /** @description `validation-error`: Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `not-found`: Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Database and snapshot sizes, Offer counts by state, and the retention constants */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The storage readout */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Storage"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/storage/wipe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Delete all Offer data
         * @description Deletes Offers (with their Ad IDs, prices, history and links), every stored page, the seeker's marks (Dismissed, Shortlisted, Contacted, scam marks), manual fact overrides and merge/split pair overrides, the crawl queue and the request log. Crawling pauses as `wiped` first: the wipe waits for the request in flight, `GET /storage` shows it under `wipe.running`, and `POST /crawl/resume` is refused with `wipe-running` until it is done. Keeps the Seeker Profile, Filters, Searches, settings and secrets. The next Resume after it runs a fresh backfill of every Search. A second request while one runs gets the same result. It can't be undone, so the body must carry the typed confirmation. The request log rows the hourly and daily request caps still count are kept, so a wipe can't reset those caps.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["WipeRequest"];
                };
            };
            responses: {
                /** @description What was deleted, and the storage readout afterwards */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["WipeResult"];
                    };
                };
                /** @description `validation-error`: Invalid request; `invalid-body`: Invalid request body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `unauthorized`: Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
                /** @description `origin-not-allowed`: Origin not allowed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/problem+json": components["schemas"]["Problem"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Problem: {
            /** @example not-found */
            type: string;
            title: string;
            status: number;
            detail?: string;
            /** @description On `validation-error`: each invalid input and why. */
            errors?: {
                path: string;
                message: string;
            }[];
            /** @description On `offer-merged`: the id of the Offer that holds the absorbed Offer's room now. */
            mergedInto?: number;
        };
        CrawlStatus: {
            /**
             * @description `cooling-down`: a Bot check Cooldown runs and cannot be cut short. `needs-resume`: the Cooldown is over but two Bot checks within 24 h need a manual Resume. `layout-changed`: a page wg-hunt could not read, or a failure while handling one, paused the crawl; `paused.cause` says which. `disk-full`: under 1 GB is free on the data folder's disk, which paused the crawl. `wiped`: "Delete all Offer data" paused the crawl; the next Resume backfills every Search. A Cooldown wins over a stop, and only the first stop is named: `holds` lists them all.
             * @enum {string}
             */
            state: "running" | "paused" | "cooling-down" | "needs-resume" | "outside-hours" | "layout-changed" | "disk-full" | "wiped";
            /** @description The latest Cooldown, until the probe after it has been answered or a Resume ended it. With `needsResume`, the crawl does not carry on by itself when it ends. */
            cooldown: {
                /** @description ISO 8601 end of the Cooldown */
                until: string;
                /** @description 1 for 2 h, 2 for 4 h, 3 for 8 h, 4 for 24 h */
                level: number;
                needsResume: boolean;
            } | null;
            paused: {
                /** @enum {string} */
                reason: "user" | "layout-changed" | "disk-full" | "wiped";
                /**
                 * @description Why a `layout-changed` pause happened. `unexpected-page`: the Source showed a page wg-hunt could not read; an update may be needed before a Resume helps. `handler-error`: wg-hunt failed while handling a page; the cause can be the disk, the database, or a page it cannot handle. A Resume tries again; if it pauses again, the server's log has the error's class and code, and the newest `handler-error` row of `GET /crawl/requests` names the page. Null for every other reason, and for a `layout-changed` pause stored before the cause was recorded.
                 * @enum {string|null}
                 */
                cause: "unexpected-page" | "handler-error" | null;
                since: string;
                path: string | null;
                /** @description Where the raw page is, relative to the data folder. Null when it could not be kept, or once a wipe or the 30-day prune deleted it */
                savedAs: string | null;
            } | null;
            /** @description Every stop that only a person ends, with a Resume, now or once the Cooldown is over: `paused` (a Pause), `layout-changed`, `disk-full`, `wiped` ("Delete all Offer data"; a Resume is refused while it still runs), `needs-resume` (two Bot checks within 24 h). One Resume lifts them all. Empty when the crawl carries on by itself. */
            holds: ("paused" | "layout-changed" | "disk-full" | "wiped" | "needs-resume")[];
            nextRequest: components["schemas"]["NextRequest"];
            actions: components["schemas"]["CrawlActions"];
            /** @description Caps are halved until then */
            halfBudgetUntil: string | null;
            counts: {
                hour: {
                    used: number;
                    cap: number;
                };
                day: {
                    used: number;
                    cap: number;
                };
            };
            nextJobs: {
                /** @enum {string} */
                kind: "poll" | "new-offer" | "deeper-page" | "stale-confirmation" | "recheck";
                path: string;
                dueAt: string;
            }[];
            lastBotCheck: components["schemas"]["BotCheckRecord"];
            settings: components["schemas"]["SettingsState"];
        };
        NextRequest: {
            /**
             * Format: date-time
             * @description When the next request is expected to go out: the earliest instant the gap, caps, active hours and any Cooldown allow, or the first queued job's due time if that is later. Null while only a Resume lets requests go (`holds` says which, including during a Cooldown that a Resume has to follow), or while nothing is queued.
             */
            at: string | null;
            /**
             * @description What holds the next request back now; null when the limits let it go and it only waits for a job to be due.
             * @enum {string|null}
             */
            waitingFor: "gap" | "hourly-cap" | "daily-cap" | "active-hours" | "cooldown" | "needs-resume" | "paused" | "layout-changed" | "disk-full" | "wiped" | null;
        };
        CrawlActions: {
            /** @description `POST /crawl/pause` would stop the crawl */
            pause: boolean;
            /** @description `POST /crawl/resume` would lift the `holds`. False when nothing waits for a Resume, and when `resumeRefusedBy` says it would be refused. */
            resume: boolean;
            /**
             * @description The problem type `POST /crawl/resume` would answer with now. `bot-check-cooldown`: a Cooldown runs. `wipe-running`: "Delete all Offer data" still runs; the Resume after it starts a fresh backfill. Null when it would not be refused.
             * @enum {string|null}
             */
            resumeRefusedBy: "bot-check-cooldown" | "wipe-running" | null;
        };
        BotCheckRecord: {
            /** @description ISO 8601 time of the Bot check */
            at: string;
            /** @description Path on the Source; no personal or location data */
            path: string;
            /** @enum {string} */
            marker: "redirect-cuba" | "checkform" | "title" | "heading" | "g-recaptcha" | "recaptcha-script" | "cuba-link" | "http-403" | "http-429";
            /** @description Requests in the hour up to this one */
            hourCount: number;
            /** @description Requests in the Berlin day up to this one */
            dayCount: number;
        } | null;
        /** @description Where the settings document the status is for came from (`GET /settings/analysis` for `GET /analysis`, `GET /settings/crawl` for `GET /crawl`), and which of its fields went back to their default because what is saved no longer parses. */
        SettingsState: {
            /**
             * @description `saved`: the settings are as saved. `default`: nothing is saved, so the defaults are in use. `partly-unreadable`: what is saved no longer parses as a whole, after an upgrade for instance; the fields in `unreadable` are back at their default, every other field kept its saved value, and the stored settings stay as they are until they are saved again.
             * @enum {string}
             */
            source: "saved" | "default" | "partly-unreadable";
            /**
             * @description The fields that went back to their default, as dotted names such as `pacing.dailyCap`; empty unless `source` is `partly-unreadable`.
             * @example [
             *       "effort"
             *     ]
             */
            unreadable: string[];
        };
        CrawlSettingsWithConstants: components["schemas"]["CrawlSettings"] & {
            constants: components["schemas"]["CrawlConstants"];
        };
        CrawlConstants: {
            maxInFlight: number;
            gapFloorSeconds: number;
            dailyCeiling: number;
            rotation: string;
            forbidden: string;
            cooldownLadderHours: number[];
            halfBudgetHours: number;
        };
        CrawlSettings: {
            pacing: {
                gapMinSeconds: number;
                gapMaxSeconds: number;
                sessionSize: number;
                breakMinMinutes: number;
                breakMaxMinutes: number;
                hourlyCap: number;
                dailyCap: number;
                activeHours: {
                    /** @example 07:00 */
                    start: string;
                    /** @example 07:00 */
                    end: string;
                };
            };
            recheck: {
                enabled: boolean;
                maxPageAgeHours: number;
            };
        };
        CrawlRequestPage: {
            items: components["schemas"]["CrawlRequest"][];
            nextCursor: string | null;
        };
        CrawlRequest: {
            id: number;
            /** @description ISO 8601 time the request was sent */
            at: string;
            /**
             * @description The kind of the job that sent the request, as in `nextJobs` on `GET /crawl`
             * @example poll
             * @enum {string}
             */
            kind: "poll" | "new-offer" | "deeper-page" | "stale-confirmation" | "recheck";
            /** @description Path on the Source; no personal or location data */
            path: string;
            status: number | null;
            /**
             * @description `pending`: sent, no response yet. `received`: the response is in and its page is being handled. Then what the Source answered (`ok`, `redirect`, `http-error`, `network-error`), or `bot-check` (no page was handled), `unexpected-page` (the page could not be read; the crawl paused), `handler-error` (handling the page failed; the crawl paused). `interrupted`: the server stopped before a response came; the same job is sent again. `handler-interrupted`: the server stopped while the page was being handled; that job is not sent again as such, but whatever its Search or Ad ID still needs is queued again at boot.
             * @example ok
             * @enum {string}
             */
            outcome: "pending" | "received" | "ok" | "redirect" | "http-error" | "network-error" | "bot-check" | "unexpected-page" | "handler-error" | "interrupted" | "handler-interrupted";
            /**
             * @description The bot-check marker that fired
             * @enum {string|null}
             */
            marker: "redirect-cuba" | "checkform" | "title" | "heading" | "g-recaptcha" | "recaptcha-script" | "cuba-link" | "http-403" | "http-429" | null;
        };
        Forecast: {
            /** @description The daily cap the forecast is worked from: the one in force now, halved for a day after a Cooldown (see `halfBudget`). */
            dailyCap: number;
            /** @description Expected requests in one day. */
            requests: {
                /** @description Page requests of polls, after stretching. */
                polls: number;
                /** @description Page requests of the daily Sweeps. */
                sweeps: number;
                /** @description Detail fetches of expected new Offers. */
                newOffers: number;
                /** @description Stale confirmation fetches for Offers a Sweep did not see. */
                confirmations: number;
                /** @description What the cap leaves for Rechecks after the four above; never negative. */
                rechecks: number;
            };
            /** @description Set while the caps are halved after a Cooldown: the forecast is worked from the halved cap until then. Null otherwise. */
            halfBudget: {
                /** @description When the full caps apply again. */
                until: string;
                /** @description The configured daily cap, in force again from `until`. */
                fullDailyCap: number;
            } | null;
            recheck: {
                enabled: boolean;
            };
            stretch: {
                /** @description What every poll interval is multiplied by so polls plus Sweeps fit in half the cap. */
                factor: number;
                /** @description True when polls plus Sweeps would pass half the cap. */
                applied: boolean;
            };
            searches: {
                id: number | null;
                enabled: boolean;
                /**
                 * @description Why an enabled Search costs nothing here, as the Search itself reports it (`poll.problem`). `unknown-city`: the Source's adapter has no id for the city, so nothing is sent for the Search. Null when the Source can read it.
                 * @enum {string|null}
                 */
                problem: "unknown-city" | null;
                /** @description Poll requests a day, after stretching. 0 for a Search that is not crawled: disabled, or with a `problem`. */
                polls: number;
                /** @description Sweep page requests a day. 0 for a Search that is not crawled. */
                sweeps: number;
                pollInterval: {
                    minMinutes: number;
                    maxMinutes: number;
                };
                /** @description The interval after stretching. */
                effectiveInterval: {
                    minMinutes: number;
                    maxMinutes: number;
                };
            }[];
            warnings: {
                /** @enum {string} */
                type: "polls-below-one-per-2h" | "over-budget" | "no-room-for-polls";
                message: string;
            }[];
        };
        ForecastDraft: {
            settings?: components["schemas"]["CrawlSettings"] & unknown;
            /** @description The complete list of Searches as the draft would have them (a changed one replaced, a new one added). Leave out to use the stored Searches. */
            searches?: components["schemas"]["DraftSearch"][];
        };
        DraftSearch: {
            /** @description The Search this draft changes; echoed back in the forecast. Leave out for a new Search. */
            id?: number;
            /** @description The city as the draft would have it. Left out, a Search named by `id` keeps its stored city, and a new Search is taken as one the Source can read. Not checked as on a Search: a city the Source cannot resolve is not refused, its row reports `unknown-city` and costs nothing. */
            city?: string;
            /** @description The Source's own number for the city, as on a Search; null for none. Left out, a Search named by `id` keeps its stored one. */
            cityId?: string | null;
            categories: ("flatshare-room" | "one-room-flat" | "flat" | "house")[];
            recencyDays: number;
            enabled: boolean;
            pollInterval: {
                minMinutes: number;
                maxMinutes: number;
            };
        };
        SearchPage: {
            items: components["schemas"]["Search"][];
            nextCursor: string | null;
        };
        Search: {
            id: number;
            /** @enum {string} */
            source: "wg-gesucht";
            city: string;
            /** @description The Source's own number for the city, needed for cities the Source's adapter doesn't know by name. On wg-gesucht.de it is the first number after the city in a search URL (`wg-zimmer-in-Hamburg.55.0.1.0.html` -> 55). Null when the adapter knows the city. */
            cityId: string | null;
            categories: ("flatshare-room" | "one-room-flat" | "flat" | "house")[];
            rentTypes: ("unlimited" | "limited" | "overnight")[];
            /** @description Loose ceiling on warm rent per month, in euros; null for none. */
            priceCeiling: number | null;
            /** @description How recent Offers must be, in days. Capped at 1 week. */
            recencyDays: number;
            enabled: boolean;
            pollInterval: components["schemas"]["PollInterval"];
            poll: components["schemas"]["SearchPoll"];
            sweep: components["schemas"]["SearchSweep"];
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        /** @description Each poll of the Search comes a random time in this range after the last one. */
        PollInterval: {
            minMinutes: number;
            maxMinutes: number;
        };
        SearchPoll: {
            /**
             * Format: date-time
             * @description When the next poll is due; it still waits for the pacing. Null while disabled or when the city is not recognised.
             */
            nextAt: string | null;
            /**
             * @description `unknown-city`: the Source's adapter has no id for the city. Give `cityId`, or the Search is never polled.
             * @enum {string|null}
             */
            problem: "unknown-city" | null;
        };
        /** @description The Search's Sweep: a full read of its window at deeper-page priority, once a day, that keeps the matched Offers honest. */
        SearchSweep: {
            /**
             * @description `idle`: nothing is swept (the Search is disabled or not readable). `scheduled`: the next Sweep starts at `startAt`. `running`: its pages are being read.
             * @enum {string}
             */
            status: "idle" | "scheduled" | "running";
            /**
             * @description `backfill`: the first full read since the Search was made, edited or became readable; Offers it does not see stop being matched. `daily`: a later Sweep; each Offer it misses gets one confirmation fetch. Null while idle.
             * @enum {string|null}
             */
            mode: "backfill" | "daily" | null;
            /**
             * Format: date-time
             * @description When the scheduled Sweep starts; it still waits for the pacing. Null unless scheduled.
             */
            startAt: string | null;
            /** @description Result pages the running Sweep has read so far; 0 unless running. */
            pagesRead: number;
            /**
             * Format: date-time
             * @description When a Sweep of this Search last finished, of either mode. Null if none has.
             */
            lastFinishedAt: string | null;
        };
        NewSearch: {
            /**
             * @description Defaults to `wg-gesucht`.
             * @enum {string}
             */
            source?: "wg-gesucht";
            city: string;
            /** @description Defaults to none. */
            cityId?: string | null;
            categories: ("flatshare-room" | "one-room-flat" | "flat" | "house")[];
            /** @description Defaults to all rent types. */
            rentTypes?: ("unlimited" | "limited" | "overnight")[];
            /** @description Defaults to no ceiling. */
            priceCeiling?: number | null;
            /** @description Defaults to 7, the longest allowed. */
            recencyDays?: number;
            /** @description Defaults to true. */
            enabled?: boolean;
            pollInterval?: components["schemas"]["PollInterval"];
        };
        SearchChanges: {
            city?: string;
            /** @description The Source's own number for the city, needed for cities the Source's adapter doesn't know by name. On wg-gesucht.de it is the first number after the city in a search URL (`wg-zimmer-in-Hamburg.55.0.1.0.html` -> 55). Null when the adapter knows the city. */
            cityId?: string | null;
            categories?: ("flatshare-room" | "one-room-flat" | "flat" | "house")[];
            rentTypes?: ("unlimited" | "limited" | "overnight")[];
            /** @description Loose ceiling on warm rent per month, in euros; null for none. */
            priceCeiling?: number | null;
            /** @description How recent Offers must be, in days. Capped at 1 week. */
            recencyDays?: number;
            enabled?: boolean;
            pollInterval?: components["schemas"]["PollInterval"];
        };
        CrawlNow: {
            /** @description How many polls were made due: one per category of the Search. */
            queued: number;
            /**
             * Format: date-time
             * @description When the first request may go out, under the gap, caps, active hours and any Cooldown. Null while only a Resume helps, including during a Cooldown that a Resume has to follow. Other polls already due may go first.
             */
            runsAt: string | null;
            /**
             * @description What holds the request back; null when it may go right away.
             * @enum {string|null}
             */
            waiting: "gap" | "hourly-cap" | "daily-cap" | "active-hours" | "cooldown" | "needs-resume" | "paused" | "layout-changed" | "disk-full" | "wiped" | null;
            /** @example Queued for 07:00 (Europe/Berlin): outside active hours. */
            message: string;
        };
        OfferPage: {
            items: components["schemas"]["OfferSummary"][];
            nextCursor: string | null;
        };
        OfferSummary: {
            /** @description wg-hunt's own id for the room. */
            id: number;
            /** @enum {string} */
            category: "flatshare-room" | "one-room-flat" | "flat" | "house";
            title: string;
            /** @description The Offer's most recently active Ad ID, as a page on the Source. */
            url: string;
            /**
             * Format: date-time
             * @description When wg-hunt first saw the room on a search card: the earliest of its Ad IDs. For display; it is not when the Offer appeared.
             */
            firstSeenAt: string;
            /**
             * Format: date-time
             * @description When the Offer was made, after its detail page was fetched (possibly hours after `firstSeenAt`). `since` follows this (as it follows `bandChangedAt`); the list order does not: it is the band, then the chosen `sort`.
             */
            createdAt: string;
            /**
             * Format: date-time
             * @description When anything wg-hunt stores about the Offer last changed: a page read (a Recheck's too), a card, a mark, a correction or an analysis.
             */
            updatedAt: string;
            /**
             * Format: date-time
             * @description When the most recently active Ad ID was last published or Bumped, as far as its card says. Null when no age was shown.
             */
            lastBumpAt: string | null;
            /**
             * @description `active` while any Ad ID's page is; `deleted` only when every Ad ID's page is.
             * @enum {string}
             */
            pageStatus: "active" | "deactivated" | "deleted";
            /** @description Deactivated, deleted, or no Bump for more than 7 days (every Ad ID counted). Stale Offers are hidden from ranking. */
            stale: boolean;
            /** @description At least one enabled Search currently matches the Offer. An Offer that is not Tracked is hidden from ranking like a Stale one, but is not Stale: it may still be active on its Source. It is never polled, Swept or Rechecked, and becomes Tracked again when a Search finds it. */
            tracked: boolean;
            /**
             * @description What the stored model facts come from: `pending` until a model pass has read the free text, `analyzed` once it has, `failed` when its calls failed. `analysisStatus` says what happens next and why.
             * @enum {string}
             */
            analysisState: "pending" | "analyzed" | "failed";
            analysisStatus: components["schemas"]["OfferAnalysisStatus"];
            band: components["schemas"]["Band"];
            /**
             * Format: date-time
             * @description When the Offer entered its current band (a move that only time causes is recorded by the next read, or within a few minutes); for a new Offer, when it was made. `since` returns Offers that entered their band after a time.
             */
            bandChangedAt: string;
            /** @description One reason per evaluated Filter. */
            reasons: components["schemas"]["Reason"][];
            chips: components["schemas"]["Chip"][];
            /**
             * @description Set when the Offer is hidden whatever the Filters say: the first of `visibility.hidden`. Its reasons are still given.
             * @enum {string|null}
             */
            hiddenBecause: "stale" | "untracked" | "dismissed" | null;
            visibility: components["schemas"]["OfferVisibility"];
            marks: components["schemas"]["OfferMarks"];
            /** @description Distance to the Place the list is sorted by (`sort=distance`); null in any other list, and when the Offer's location is not known. */
            distance: {
                place: string;
                /** @description Straight-line kilometres, to two decimals. */
                km: number;
                /** @description True when the Offer gives no coordinates and the centre of its PLZ stood in for them. */
                approximate: boolean;
            } | null;
            keyFacts: {
                /** @description Euros per month. `converted` marks a per-night or per-day price multiplied by 30. */
                warmRent: {
                    amount: number;
                    converted: boolean;
                } | null;
                /** @description Square metres: the room for a flatshare, the whole home otherwise. */
                size: number | null;
                district: string | null;
                /** @description An ISO date. */
                availableFrom: string | null;
            };
        };
        OfferAnalysisStatus: {
            status: components["schemas"]["AnalysisStatusKind"];
            /**
             * @description What moves it on: `none`, `wait` (it moves on by itself), `add-key`, `replace-key`, `raise-cap` (or wait until `at`; with `at` null, for what is in flight to settle), `reanalyze` (`POST /offers/{id}/reanalyze`), `start-run` (`POST /analysis/runs`), `recheck` (`POST /offers/{id}/recheck`). A status that waits for a click or a run (`needs-click`, `kept-previous`, `escalation-lost`, `older-version`) says `add-key`, `replace-key` or `raise-cap` instead while the server would refuse that click or run. `kept-previous` and `escalation-lost` say `recheck` while a page failure stands, whatever the key and the cap: a Re-analyse would fail on the same stored page at once.
             * @enum {string}
             */
            next: "none" | "wait" | "add-key" | "replace-key" | "raise-cap" | "reanalyze" | "start-run" | "recheck";
            /** @description The error kind behind a failed status, such as `overloaded`, or `outcome_not_stored`; null otherwise. */
            reason: string | null;
            /**
             * Format: date-time
             * @description Since when (`in-batch`, `provisional`), when the next attempt is made (`retry-at`), or when the cap resets (`waiting-for-cap`, and `next: raise-cap` while the cap is reached); null otherwise.
             */
            at: string | null;
            /** @description It will be read without anyone doing anything. `awaiting` in `GET /analysis` counts these. */
            willRead: boolean;
        };
        /**
         * @description Where the Offer's analysis stands. Read without anyone acting (`willRead`): `reading` (a call is in flight), `queued` (sent at the next cycle, including a Re-analyse click not yet served), `in-batch` (its request waits for or is inside a batch, since `at`), `provisional` (the first pass is shown while the escalation pass waits in a batch, since `at`), `words-changed` (the words changed since it was read; the next cycle reads them again), `waiting-for-in-flight` (the calls and batches in flight hold the rest of the spend cap; it is read once they settle). A request a batch holds is read whatever the cap says, but not without a key: it is `waiting-for-key` or `key-refused` then. Waiting: `retry-at` (the last attempt failed with `reason`; the next is at `at`), `waiting-for-cap` (the month's spend cap is reached, or what is left of it does not pay for this Offer's own call; it resets at `at`), `waiting-for-key` (no Anthropic key), `key-refused` (the API refused the key that is set), `waiting-for-page` (not read yet, and no readable page is stored, `reason`; once a Recheck stores one it is read like any Offer), `needs-click` (the last attempt failed with `reason` in a way trying again would only repeat: it waits for new words or Re-analyse). Read: `analyzed` (current), `kept-previous` (the last attempt failed with `reason`; the previous result is kept), `escalation-lost` (the first pass is shown but its escalation pass is gone, with `reason` when a failure ended it), `older-version` (read at an older analysis version; only a re-analysis run reads it again), `stale` (Stale Offers are never read). `reason: outcome_not_stored` on `needs-click` or `kept-previous` is no error kind: the call was made and billed, but the database took no write of its outcome, so nothing recorded it. The server sends it again only after a Re-analyse, or once after a restart. A page failure (`reason` is `no_stored_page` or `unreadable_page`) says the stored page of the Offer's current Ad ID is missing or cannot be read, so nothing was sent. It ends as soon as the current Ad ID's stored page reads, whether a Recheck stored one or the Offer moved to another Ad ID whose page is stored, and nothing is read because of that alone: `kept-previous` becomes `analyzed` or `older-version`, `escalation-lost` stays and waits for Re-analyse, and a `waiting-for-page` Offer waits to be read like any other.
         * @enum {string}
         */
        AnalysisStatusKind: "reading" | "queued" | "in-batch" | "provisional" | "words-changed" | "retry-at" | "needs-click" | "waiting-for-page" | "waiting-for-key" | "key-refused" | "waiting-for-cap" | "waiting-for-in-flight" | "kept-previous" | "escalation-lost" | "older-version" | "analyzed" | "stale";
        /**
         * @description `match` passes every Filter on evidence that checked out; `near-match` misses only Wants, or rests on unknown, Doubtful or incomplete evidence; `warned` is a Likely scam; `hidden` fails a Dealbreaker on a known value, is Stale, Untracked or Dismissed.
         * @enum {string}
         */
        Band: "match" | "near-match" | "warned" | "hidden";
        Reason: {
            /** @enum {string} */
            filter: "anmeldung" | "genderSought" | "requirements" | "ageSought" | "moveIn" | "stayAvailable" | "stayMinimum" | "maxRent" | "minSize" | "maxRentPerSqm" | "furnished" | "smoking" | "pets" | "flatshareTypes" | "area" | "distance" | "languages" | "hideLikelyScams" | "flatmateAges";
            /** @enum {string} */
            strength: "dealbreaker" | "want";
            /**
             * @description `pass` is a ✓, `warn` a ⚠ (weak evidence or inside a margin), `fail` a ✗.
             * @enum {string}
             */
            outcome: "pass" | "warn" | "fail";
            /**
             * @description What this reason does to the Offer's band.
             * @enum {string}
             */
            effect: "none" | "near-match" | "hidden";
            /** @enum {string} */
            cause: "met" | "missed" | "within-margin" | "unknown" | "doubtful" | "incomplete-costs" | "conditional" | "early" | "worth-asking";
            /** @description A sentence for the seeker. */
            message: string;
            /** @description The Offer's own words (or field and value) the reason rests on. */
            quote?: string;
        };
        Chip: {
            /** @enum {string} */
            kind: "converted-rent" | "costs-incomplete" | "requirement" | "scam-caution";
            /** @enum {string} */
            tone: "ok" | "info" | "warn";
            label: string;
            quote?: string;
            /** @description What a rule compared, for a chip that rests on a rule such as a Scam signal. */
            evidence?: string;
        };
        /** @description What hides the Offer, since when, what ends each cause, and what the seeker may do. */
        OfferVisibility: {
            /** @description Every cause that hides the Offer whatever the Filters say, in precedence order (stale, untracked, dismissed); empty when none does. The band is always `hidden` when this is not empty. */
            hidden: components["schemas"]["HiddenCause"][];
            actions: {
                /** @description A Recheck may be asked for: the current Ad ID is Tracked. `POST /offers/{id}/recheck` refuses with `offer-untracked` otherwise. */
                recheck: boolean;
                /** @description The Offer is Dismissed, so the mark can be taken off. */
                undismiss: boolean;
            };
        };
        HiddenCause: {
            /** @enum {string} */
            cause: "stale";
            /**
             * @description `aged`: no Ad ID with a live page was Bumped for more than 7 days. `deactivated`: no page is live and at least one is deactivated. `deleted`: every page was deleted.
             * @enum {string}
             */
            why: "aged" | "deactivated" | "deleted";
            /**
             * Format: date-time
             * @description When the last live Ad ID aged out; null for a deactivated or deleted page.
             */
            since: string | null;
            /**
             * @description What makes it shown again: a Bump seen by a poll or Sweep, the page live again on a Recheck, or a re-post that collapses into the Offer.
             * @enum {string}
             */
            endsWhen: "bumped" | "reactivated" | "reposted";
        } | {
            /** @enum {string} */
            cause: "untracked";
            /**
             * Format: date-time
             * @description When it went Untracked. Not recorded yet, so always null.
             */
            since: string | null;
            /**
             * @description An enabled Search lists one of its Ad IDs again.
             * @enum {string}
             */
            endsWhen: "a-search-matches";
        } | {
            /** @enum {string} */
            cause: "dismissed";
            /**
             * Format: date-time
             * @description When the seeker marked it not for me.
             */
            since: string | null;
            /**
             * @description The seeker takes the mark off.
             * @enum {string}
             */
            endsWhen: "undismissed";
        };
        OfferMarks: {
            /** @description "Not for me": the Offer is Hidden (`hiddenBecause` is `dismissed`), and stays so when it is re-posted, because a Duplicate collapses into it. */
            dismissed: boolean;
            /** @description Display only. */
            shortlisted: boolean;
            /** @description Display only. */
            contacted: boolean;
        };
        OfferCounts: {
            bands: {
                match: number;
                "near-match": number;
                warned: number;
                hidden: number;
            };
            new: number;
        };
        FactOverrideList: {
            items: {
                offerId: number;
                /** @enum {string} */
                source: "wg-gesucht";
                adId: string;
                key: string;
                value?: unknown;
                /** Format: date-time */
                createdAt: string;
                /** @description The Ad ID whose page was current when the correction was made. It can be one that is no longer the current one, or no longer the Offer's. Null for a correction made before this was recorded. */
                madeOn: {
                    /** @enum {string} */
                    source: "wg-gesucht";
                    adId: string;
                    /** @description The fingerprint of the words that page showed, as in an Ad ID's `textHash`. Null when they were not known. */
                    textHash: string | null;
                } | null;
                /** @description Whether the current Ad ID's words differ from those the correction was made on. Words alike on another Ad ID read `false`. Null when either is not known. Correcting the fact again makes it `false`. */
                wordsChanged: boolean | null;
                /** @description The Offer's Ad IDs. */
                adCount: number;
            }[];
        };
        Offer: components["schemas"]["OfferSummary"] & {
            /** @description Every `(Source, Ad ID)` pair the Offer is known under, oldest first. */
            ads: components["schemas"]["OfferAd"][];
            advertiser: {
                name: string | null;
                avatarUrl: string | null;
                /** @enum {string|null} */
                kind: "private" | "pro" | "company" | null;
            };
            /** @description Addresses of the photos on the Source. The browser loads them directly; wg-hunt never downloads an image. */
            photos: string[];
            /** @description The Offer Facts by name: the rule-parsed ones with the model's beside them once it has read the text. `requirements`, `scamSignals` and `conflicts` are lists of facts. Facts that do not apply to the Offer's category are left out. A model fact carries `confidence`: confident, or Doubtful with its reasons. */
            facts: {
                [key: string]: components["schemas"]["OfferFact"] | components["schemas"]["OfferFact"][];
            };
            analysis: components["schemas"]["OfferAnalysis"];
            /** @description Warm rent over time, oldest first; a point only when it changed. */
            priceHistory: {
                /** Format: date-time */
                observedAt: string;
                /** @enum {string} */
                source: "wg-gesucht";
                adId: string;
                warmRent: number;
                converted: boolean;
            }[];
            /** @description Every Text version of the Offer's Ad IDs, oldest first. A version is kept whenever an Ad ID's page shows words it has not shown before, including an edit a Recheck finds. Ad IDs stored before text history existed start theirs at their next read. */
            textHistory: components["schemas"]["TextVersion"][];
            rulesVersion: number;
            /** @description Other rooms of the same flat by the same Advertiser: linked as "same flat", never merged. */
            siblings: components["schemas"]["RelatedOffer"][];
            /** @description Offers of other Advertisers that reuse this one's photos or text, or that it reuses. */
            cloned: components["schemas"]["ClonedOffer"][];
            scam: components["schemas"]["ScamVerdict"];
            /** @description The names of the facts the seeker corrected by hand: each shows in `facts` with origin `manual`. A list fact corrected to an empty list has no fact left to show, so it is named here. */
            overrides: string[];
            /** @description The same corrections as `overrides`, by name, with when each was made and on which page. */
            corrections: {
                key: string;
                /** Format: date-time */
                createdAt: string;
                /** @description The Ad ID whose page was current when the correction was made. It can be one that is no longer the current one, or no longer the Offer's. Null for a correction made before this was recorded. */
                madeOn: {
                    /** @enum {string} */
                    source: "wg-gesucht";
                    adId: string;
                    /** @description The fingerprint of the words that page showed, as in an Ad ID's `textHash`. Null when they were not known. */
                    textHash: string | null;
                } | null;
                /** @description Whether the current Ad ID's words differ from those the correction was made on. Words alike on another Ad ID read `false`. Null when either is not known. Correcting the fact again makes it `false`. */
                wordsChanged: boolean | null;
            }[];
            recheck: components["schemas"]["OfferRecheck"];
            retention: components["schemas"]["OfferRetention"];
        };
        OfferAd: {
            /** @enum {string} */
            source: "wg-gesucht";
            adId: string;
            url: string;
            /** Format: date-time */
            firstSeenAt: string;
            /** Format: date-time */
            lastBumpAt: string | null;
            /** @enum {string} */
            pageStatus: "active" | "deactivated" | "deleted";
            /** @description The most recently active Ad ID: an active page before a deactivated one before a deleted one, then the latest Bump. The Offer's facts, link and Recheck follow it. */
            current: boolean;
            /** @description A fingerprint of the Ad ID's own words. Ad IDs of one Offer with different hashes had their text edited between the posts. */
            textHash: string | null;
        };
        OfferFact: {
            /** @description The fact's value, or the string `unknown` when the Offer does not say. */
            value?: unknown;
            /** @enum {string} */
            origin: "field" | "text" | "manual";
            /** @description An exact piece of the Offer, or the field label plus its value, that the value was read from. */
            quote: string;
            alternatives?: {
                value?: unknown;
                /** @enum {string} */
                origin: "field" | "text" | "manual";
                quote: string;
            }[];
            /** @description Only model facts carry one: confident, or Doubtful with the reasons its checks failed. */
            confidence?: {
                /** @enum {string} */
                status: "confident";
            } | {
                /** @enum {string} */
                status: "doubtful";
                reasons: string[];
            };
        };
        OfferAnalysis: {
            /** @enum {string} */
            state: "pending" | "analyzed" | "failed";
            /** @description The model the last successful analysis ran with; null before one succeeded. */
            model: string | null;
            effort: string | null;
            /** @description The escalation setting at the time; null when escalation was off. */
            escalation: {
                model: string;
                effort: string | null;
            } | null;
            /** @description A Doubtful fact made the whole Offer be read again at the escalation setting. */
            escalated: boolean;
            /** Format: date-time */
            analyzedAt: string | null;
            /** @description The analysis version (a hash of the prompt, the output schema, the model and the effort) the stored result was read with; null before one succeeded. Compare it with `version` of `GET /analysis`. */
            analysisVersion: string | null;
            /** @description The stored result is on an older analysis version than the current settings would make. Nothing is re-read until a re-analysis run is started. */
            olderVersion: boolean;
            /** @description What the checks noticed: a quote that was not found, a tiers disagreement and so on. Includes the attempts whose value was turned `unknown`. */
            log: {
                tier: number;
                fact: string;
                event: string;
                value: string;
                quote: string;
                note?: string;
            }[];
        };
        /** @description The title and free-text sections of one Ad ID exactly as the Advertiser wrote them, never the translation. */
        TextVersion: {
            /** @enum {string} */
            source: "wg-gesucht";
            adId: string;
            /**
             * Format: date-time
             * @description When wg-hunt first saw these words.
             */
            seenAt: string;
            /** @description The words' fingerprint: equal to the Ad ID's `textHash` while they are current. */
            hash: string;
            title: string;
            /** @description The free-text sections, in page order. */
            sections: {
                label: string;
                text: string;
            }[];
        };
        RelatedOffer: {
            offer: components["schemas"]["OfferSummary"];
            /** @description Photos both Offers show, by original file name (photo key). */
            sharedImages: number;
            /** @description 0 (nothing alike) to 1 (the same words); null when either text was too short to compare. */
            textSimilarity: number | null;
        };
        ClonedOffer: {
            offer: components["schemas"]["OfferSummary"];
            /** @description Photos both Offers show, by original file name (photo key). */
            sharedImages: number;
            /** @description 0 (nothing alike) to 1 (the same words); null when either text was too short to compare. */
            textSimilarity: number | null;
            /**
             * @description Which side this Offer is: the `copy` first appeared after the `original`. The two are never merged.
             * @enum {string}
             */
            role: "original" | "copy";
        };
        /** @description The Scam signals with their quotes or evidence, and the verdict. Derived signals are worked out on every read. */
        ScamVerdict: {
            /** @description The verdict ranking uses: the seeker's mark when there is one, else the computed verdict. A Likely scam is in the Warned band. */
            likelyScam: boolean;
            /** @description What the signals alone say: one strong or three soft signals. */
            computedLikelyScam: boolean;
            /**
             * @description The seeker's override: `scam`, `not` (not a scam), or null.
             * @enum {string|null}
             */
            mark: "scam" | "not" | null;
            /** @description Every signal found, strong first: the reasons behind the verdict. */
            signals: components["schemas"]["ScamSignal"][];
            /** @description The soft signals shown as caution chips: below the threshold and not overridden by a mark. */
            cautions: components["schemas"]["ScamSignal"][];
            strong: number;
            soft: number;
            /** @description One sentence on how the verdict came about. */
            summary: string;
        };
        ScamSignal: {
            /** @enum {string} */
            kind: "money_before_viewing" | "keys_by_post" | "cannot_show_in_person" | "deposit_over_three_months" | "off_platform_contact" | "id_copy_upfront" | "new_unverified_account" | "rent_below_median" | "price_mismatch" | "cloned_offer";
            /**
             * @description A strong signal is enough for a Likely scam on its own; three soft ones are. A Doubtful reading is always soft.
             * @enum {string}
             */
            strength: "strong" | "soft";
            /**
             * @description `text`: the model read it in the Offer's words. `derived`: the rules worked it out from the facts and the other Offers.
             * @enum {string}
             */
            origin: "text" | "derived";
            /** @description A sentence for the seeker. */
            message: string;
            /** @description The Offer's own words (or field and value) behind the signal. */
            quote?: string;
            /** @description What a rule compared, such as the baseline: "district median €18.40/m² from 23 Offers". */
            evidence?: string;
            /** @description The model's reading is Doubtful, so the signal counts as soft. */
            doubtful: boolean;
        };
        /** @description Where a Recheck of the current Ad ID's page stands: the page `POST /offers/{id}/recheck` asks for. Poll this after asking to see when it finished. */
        OfferRecheck: {
            /**
             * @description `queued`: a Recheck is due and waits its turn. A pressed or automatic one goes last; the re-read of a Stale Ad ID that shows up on a search card again goes where a new Offer's page does. A pressed one or such a re-read that a Bot check dropped is put back and stays `queued`. `in-flight`: its request is out. `failed`: the last Recheck brought no usable page (no answer, an error, a page the rules could not read); automatic Rechecks and a returning Stale Ad ID's re-read wait until `retryAfter`. `idle`: none of these. A returning Stale Ad ID's re-read also waits 6 hours after a Recheck that read the page fine, and shows `idle` meanwhile, with nothing else on the Offer saying it waits, until it is due and turns `queued`. A press is `queued` at once, during either wait too. A Recheck has finished when the state leaves `queued` and `in-flight`; `pageFetchedAt` then moved if it got a page.
             * @enum {string}
             */
            state: "idle" | "queued" | "in-flight" | "failed";
            /** @description The queued or in-flight Recheck was asked for with the Recheck button. */
            manual: boolean;
            /**
             * Format: date-time
             * @description When the page was last fetched, by a Recheck or otherwise.
             */
            pageFetchedAt: string | null;
            /**
             * Format: date-time
             * @description When the last Recheck that brought no usable page was answered; null once a fetched page was stored.
             */
            lastFailedAt: string | null;
            /**
             * Format: date-time
             * @description While `failed`: when an automatic Recheck may try the page again.
             */
            retryAfter: string | null;
        };
        /** @description What the nightly prune will do with the Offer: what keeps its record, and when the record and the snapshots fall due. */
        OfferRetention: {
            /**
             * @description `not-quiet`: neither Stale nor Untracked, so no clock runs. `expiring`: quiet, and the record is deleted 90 days after it went quiet. `kept`: quiet, but `keptBecause` keeps the record; the snapshots still age.
             * @enum {string}
             */
            state: "not-quiet" | "expiring" | "kept";
            /** @description What keeps the record from being pruned, in this order: the marks `dismissed`, `shortlisted`, `contacted`, a `scam-mark` (scam or not a scam), a manual `fact-override`, and `pair-override`: a same-room or not-the-same-room verdict on one of its Ad IDs. Clear the mark or override to let the record expire; release a `pair-override` with `POST /offers/{id}/retention/release`. Named even while the Offer is not quiet. */
            keptBecause: ("dismissed" | "shortlisted" | "contacted" | "scam-mark" | "fact-override" | "pair-override")[];
            /**
             * Format: date-time
             * @description When the record (facts, Ad IDs, history, links) falls due: the nightly prune at 03:00 Berlin after it deletes it. Null while it is not quiet or something keeps it. A clock not yet started counts from the next prune, which starts it.
             */
            recordExpiresAt: string | null;
            /**
             * Format: date-time
             * @description When the raw snapshots of its Ad IDs' pages fall due, 30 days after it went quiet, marks or not. Null while it is not quiet.
             */
            snapshotExpiresAt: string | null;
        };
        OfferMarksChange: {
            /** @description "Not for me": the Offer is Hidden (`hiddenBecause` is `dismissed`), and stays so when it is re-posted, because a Duplicate collapses into it. */
            dismissed?: boolean;
            /** @description Display only. */
            shortlisted?: boolean;
            /** @description Display only. */
            contacted?: boolean;
            /**
             * @description The seeker's override of the Likely scam verdict; `clear` takes it away.
             * @enum {string}
             */
            scam?: "scam" | "not" | "clear";
        };
        FactOverride: {
            /** @description The corrected value; its shape depends on the fact. */
            value?: unknown;
        };
        RecheckQueued: {
            /** @enum {boolean} */
            queued: true;
            /** @description A Recheck of this Offer was already waiting; no second one was queued. */
            alreadyQueued: boolean;
            /** @example Queued. Rechecks go last: this one runs when nothing else is waiting. */
            message: string;
        };
        ReanalyzeAccepted: {
            offerId: number;
            /** @enum {boolean} */
            queued: true;
        };
        /** @description Who is looking. Every personal value ships unset (null); a Filter that needs a value the seeker has not given is not evaluated. */
        SeekerProfile: {
            /** @enum {string|null} */
            gender: "woman" | "man" | "diverse" | null;
            age: number | null;
            anmeldungNeeded: boolean;
            moveIn: {
                earliest: string | null;
                latest: string | null;
            };
            stay: {
                minMonths: number | null;
                maxMonths: number | null;
            };
            /** @enum {string|null} */
            diet: "omnivore" | "vegetarian" | "vegan" | null;
            /** @enum {string|null} */
            occupation: "student" | "working" | "trainee" | null;
            smoker: boolean | null;
            hasPets: boolean | null;
            languages: string[];
            /** @default [] */
            places: {
                name: string;
                plz?: string;
                lat?: number;
                lng?: number;
            }[];
        };
        /** @description The active Filter set: each Filter can be switched off and is a Dealbreaker (hides) or a Want (moves to Near match). A numeric Filter with no limit set is not evaluated; its margin keeps a near miss in Near match. */
        Filters: {
            anmeldung: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
            };
            genderSought: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
            };
            requirements: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
            };
            ageSought: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
            };
            moveIn: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
                marginDays: number | null;
            };
            stayAvailable: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
            };
            stayMinimum: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
            };
            maxRent: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
                limit: number | null;
                margin: {
                    value: number;
                    /** @enum {string} */
                    unit: "absolute" | "percent";
                } | null;
            };
            minSize: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
                limit: number | null;
                margin: {
                    value: number;
                    /** @enum {string} */
                    unit: "absolute" | "percent";
                } | null;
            };
            maxRentPerSqm: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
                limit: number | null;
                margin: {
                    value: number;
                    /** @enum {string} */
                    unit: "absolute" | "percent";
                } | null;
            };
            furnished: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
                accept: ("furnished" | "partly_furnished" | "unfurnished")[];
            };
            smoking: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
            };
            pets: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
            };
            flatshareTypes: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
                anyOf: ("purpose_wg" | "students" | "women_only" | "men_only" | "business" | "dormitory" | "working_professionals" | "trainees" | "seniors" | "with_children" | "fraternity" | "not_purpose_wg" | "mixed_gender" | "plus" | "multigenerational" | "vegetarian_vegan" | "lgbtqia" | "living_for_help" | "single_parents" | "internationals_welcome" | "inclusive" | "functional" | "new_flatshare" | "no_gender_given")[];
            };
            area: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
                anyOf: string[];
            };
            distance: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
                place: string | null;
                limit: number | null;
                margin: {
                    value: number;
                    /** @enum {string} */
                    unit: "absolute" | "percent";
                } | null;
            };
            languages: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
            };
            hideLikelyScams: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker";
            };
            flatmateAges: {
                enabled: boolean;
                /** @enum {string} */
                strength: "dealbreaker" | "want";
                min: number | null;
                max: number | null;
            };
        };
        /** @description The saved Seeker Profile and Filter set, with their revisions. */
        Seeking: {
            profile: components["schemas"]["SeekerProfile"];
            filters: components["schemas"]["Filters"];
            revisions: {
                /** @description Send it back as `revisions.profile`, or as `If-Match` on `PUT /profile`. */
                profile: string;
                /** @description Send it back as `revisions.filters`, or as `If-Match` on `PUT /filters`. */
                filters: string;
            };
        };
        /** @description At least one of `profile` and `filters`. The same keys as `RankingPreviewRequest`, so a previewed draft can be saved as it is. */
        SeekingChanges: {
            /** @description The whole new Seeker Profile. Left out, the saved one stays. */
            profile?: {
                /** @enum {string|null} */
                gender: "woman" | "man" | "diverse" | null;
                age: number | null;
                anmeldungNeeded: boolean;
                moveIn: {
                    earliest: string | null;
                    latest: string | null;
                };
                stay: {
                    minMonths: number | null;
                    maxMonths: number | null;
                };
                /** @enum {string|null} */
                diet: "omnivore" | "vegetarian" | "vegan" | null;
                /** @enum {string|null} */
                occupation: "student" | "working" | "trainee" | null;
                smoker: boolean | null;
                hasPets: boolean | null;
                languages: string[];
                /** @default [] */
                places: {
                    name: string;
                    plz?: string;
                    lat?: number;
                    lng?: number;
                }[];
            };
            /** @description The whole new Filter set. Left out, the saved one stays. */
            filters?: {
                anmeldung: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                genderSought: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                requirements: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                ageSought: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                moveIn: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    marginDays: number | null;
                };
                stayAvailable: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                stayMinimum: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                maxRent: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    limit: number | null;
                    margin: {
                        value: number;
                        /** @enum {string} */
                        unit: "absolute" | "percent";
                    } | null;
                };
                minSize: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    limit: number | null;
                    margin: {
                        value: number;
                        /** @enum {string} */
                        unit: "absolute" | "percent";
                    } | null;
                };
                maxRentPerSqm: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    limit: number | null;
                    margin: {
                        value: number;
                        /** @enum {string} */
                        unit: "absolute" | "percent";
                    } | null;
                };
                furnished: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    accept: ("furnished" | "partly_furnished" | "unfurnished")[];
                };
                smoking: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                pets: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                flatshareTypes: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    anyOf: ("purpose_wg" | "students" | "women_only" | "men_only" | "business" | "dormitory" | "working_professionals" | "trainees" | "seniors" | "with_children" | "fraternity" | "not_purpose_wg" | "mixed_gender" | "plus" | "multigenerational" | "vegetarian_vegan" | "lgbtqia" | "living_for_help" | "single_parents" | "internationals_welcome" | "inclusive" | "functional" | "new_flatshare" | "no_gender_given")[];
                };
                area: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    anyOf: string[];
                };
                distance: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    place: string | null;
                    limit: number | null;
                    margin: {
                        value: number;
                        /** @enum {string} */
                        unit: "absolute" | "percent";
                    } | null;
                };
                languages: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                hideLikelyScams: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker";
                };
                flatmateAges: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    min: number | null;
                    max: number | null;
                };
            };
            /** @description Each revision given is checked, also for a document the write leaves out, before anything is written. */
            revisions?: {
                /**
                 * @description The Seeker Profile's revision when it was read: its `ETag`, or the one this route answered. If it has changed since, nothing is saved. Left out, it is not checked.
                 * @example "3f2a9c0d1b7e4a56"
                 */
                profile?: string;
                /**
                 * @description The Filter set's revision when it was read: its `ETag`, or the one this route answered. If it has changed since, nothing is saved. Left out, it is not checked.
                 * @example "3f2a9c0d1b7e4a56"
                 */
                filters?: string;
            };
        };
        RankingPreview: {
            /** @description The Offers that would change band, newest first. Compared with the saved Profile and Filters. */
            changes: {
                offerId: number;
                title: string;
                from: components["schemas"]["Band"];
                to: components["schemas"]["Band"];
            }[];
            counts: {
                before: {
                    match: number;
                    "near-match": number;
                    warned: number;
                    hidden: number;
                };
                after: {
                    match: number;
                    "near-match": number;
                    warned: number;
                    hidden: number;
                };
            };
        };
        RankingPreviewRequest: {
            /** @description A draft Seeker Profile. Left out, the saved one is used. */
            profile?: {
                /** @enum {string|null} */
                gender: "woman" | "man" | "diverse" | null;
                age: number | null;
                anmeldungNeeded: boolean;
                moveIn: {
                    earliest: string | null;
                    latest: string | null;
                };
                stay: {
                    minMonths: number | null;
                    maxMonths: number | null;
                };
                /** @enum {string|null} */
                diet: "omnivore" | "vegetarian" | "vegan" | null;
                /** @enum {string|null} */
                occupation: "student" | "working" | "trainee" | null;
                smoker: boolean | null;
                hasPets: boolean | null;
                languages: string[];
                /** @default [] */
                places: {
                    name: string;
                    plz?: string;
                    lat?: number;
                    lng?: number;
                }[];
            };
            /** @description A draft Filter set. Left out, the saved one is used. */
            filters?: {
                anmeldung: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                genderSought: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                requirements: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                ageSought: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                moveIn: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    marginDays: number | null;
                };
                stayAvailable: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                stayMinimum: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                maxRent: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    limit: number | null;
                    margin: {
                        value: number;
                        /** @enum {string} */
                        unit: "absolute" | "percent";
                    } | null;
                };
                minSize: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    limit: number | null;
                    margin: {
                        value: number;
                        /** @enum {string} */
                        unit: "absolute" | "percent";
                    } | null;
                };
                maxRentPerSqm: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    limit: number | null;
                    margin: {
                        value: number;
                        /** @enum {string} */
                        unit: "absolute" | "percent";
                    } | null;
                };
                furnished: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    accept: ("furnished" | "partly_furnished" | "unfurnished")[];
                };
                smoking: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                pets: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                flatshareTypes: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    anyOf: ("purpose_wg" | "students" | "women_only" | "men_only" | "business" | "dormitory" | "working_professionals" | "trainees" | "seniors" | "with_children" | "fraternity" | "not_purpose_wg" | "mixed_gender" | "plus" | "multigenerational" | "vegetarian_vegan" | "lgbtqia" | "living_for_help" | "single_parents" | "internationals_welcome" | "inclusive" | "functional" | "new_flatshare" | "no_gender_given")[];
                };
                area: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    anyOf: string[];
                };
                distance: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    place: string | null;
                    limit: number | null;
                    margin: {
                        value: number;
                        /** @enum {string} */
                        unit: "absolute" | "percent";
                    } | null;
                };
                languages: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                };
                hideLikelyScams: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker";
                };
                flatmateAges: {
                    enabled: boolean;
                    /** @enum {string} */
                    strength: "dealbreaker" | "want";
                    min: number | null;
                    max: number | null;
                };
            };
        };
        /** @description A fictional Seeker Profile, Filter set and Search to start from. Nothing here is saved. */
        ExamplePreset: {
            profile: components["schemas"]["SeekerProfile"];
            filters: components["schemas"]["Filters"];
            search: components["schemas"]["ExamplePresetSearch"];
        };
        /** @description The fields of a new Search (`POST /searches`); it is not created. */
        ExamplePresetSearch: {
            city: string;
            categories: ("flatshare-room" | "one-room-flat" | "flat" | "house")[];
            rentTypes: ("unlimited" | "limited" | "overnight")[];
            priceCeiling: number;
            recencyDays: number;
        };
        Secret: {
            /** @enum {string} */
            name: "anthropic";
            set: boolean;
            /** @example sk-ant-…a1b2 */
            masked: string | null;
            /** Format: date-time */
            updatedAt: string | null;
        };
        AnalysisSettings: {
            model: string;
            /** @enum {string|null} */
            effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
            escalation: {
                model: string;
                /** @enum {string|null} */
                effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
            } | null;
            batchOnly: boolean;
            monthlySpendCapUsd: number;
            prices: components["schemas"]["ModelPrice"][];
        };
        ModelPrice: {
            model: string;
            inputUsdPerMTok: number;
            outputUsdPerMTok: number;
            efforts: ("low" | "medium" | "high" | "xhigh" | "max")[];
            longPrompt?: {
                aboveTokens: number;
                inputUsdPerMTok: number;
                outputUsdPerMTok: number;
            } | null;
        };
        AnalysisStatus: {
            /**
             * @description `absent` (no key: Offers stay `pending` and crawling goes on), `present`, or `refused`: the API answered `unauthorized` to the key that is set. It stays refused until a key is saved, the same one included, or a call with it goes through.
             * @enum {string}
             */
            key: "absent" | "present" | "refused";
            counts: {
                pending: number;
                analyzed: number;
                failed: number;
            };
            /** @description Offers that will be read without anyone doing anything (`willRead`): reading, queued, in a batch, provisional, with changed words, or waiting for what is in flight to settle. Offers waiting for a key, the month's cap, a backoff, a page or a click are not counted; `byStatus` has them. */
            awaiting: number;
            byStatus: components["schemas"]["AnalysisStatusCounts"];
            /** @description The analysis version the current settings produce: a hash of the prompt, the output schema, the model id and the effort. Every stored result is stamped with the version it was made at. */
            version: string;
            olderVersion: components["schemas"]["OlderAnalysisVersion"];
            spend: components["schemas"]["AnalysisSpend"];
            /** @description The re-analysis run still going, or null. Only one runs at a time. */
            activeRunId: number | null;
            settings: components["schemas"]["SettingsState"];
        };
        /** @description Offers in each analysis status. */
        AnalysisStatusCounts: {
            reading: number;
            queued: number;
            "in-batch": number;
            provisional: number;
            "words-changed": number;
            "retry-at": number;
            "needs-click": number;
            "waiting-for-page": number;
            "waiting-for-key": number;
            "key-refused": number;
            "waiting-for-cap": number;
            "waiting-for-in-flight": number;
            "kept-previous": number;
            "escalation-lost": number;
            "older-version": number;
            analyzed: number;
            stale: number;
        };
        OlderAnalysisVersion: {
            /** @description Non-Stale Offers whose stored result was made at another analysis version, not already in a batch. Nothing re-runs until `POST /analysis/runs`. */
            count: number;
            /** @description About what re-analysing them as a batch would cost, from the price table at the Batch API's half price. */
            estimatedCostUsd: number;
        };
        AnalysisSpend: {
            /**
             * @description The Berlin calendar month being counted. The cap starts over each month.
             * @example 2026-11
             */
            month: string;
            /** @description This month's spend, from the tokens each call used and the price table. */
            spentUsd: number;
            capUsd: number;
            /** @description Worst-case cost held against the cap by realtime calls in flight and batches whose results are not in. Each is replaced by its actual cost when it settles. */
            reservedUsd: number;
            /** @description What may still be reserved: the cap less this month's spend and every reservation. Negative when the cap was lowered under what is reserved. */
            headroomUsd: number;
            /**
             * @description Whether model calls may go out. `ok`: the cap less this month's spend and what batches in flight reserved pays for at least one typical batch call (realtime calls in flight are not counted here). `waiting-for-in-flight`: it does not, but would once the batches in flight settle, so this may clear by itself. `reached`: even with nothing in flight, this month's cap pays for no call; it clears at `resetsAt` or with a higher cap. In either held state no new call goes out, new Offers stay `pending`, re-analysis runs and Re-analyse are refused with `spend-cap-reached`, and crawling goes on.
             * @enum {string}
             */
            state: "ok" | "waiting-for-in-flight" | "reached";
            /**
             * @description When the next Berlin calendar month, and with it a fresh cap, starts.
             * @example 2026-11-30T23:00:00.000Z
             */
            resetsAt: string;
        };
        AnalysisRun: {
            id: number;
            /**
             * @description `running` until every request is settled; then `succeeded`, `partial` (some failed), `failed` (none kept) or `stopped` (see `stopReason`). Written once when the run settles: deleting its Offers later does not change it.
             * @enum {string}
             */
            status: "running" | "succeeded" | "partial" | "failed" | "stopped";
            createdAt: string;
            finishedAt: string | null;
            /** @description The version the run brings Offers to. */
            analysisVersion: string;
            estimatedCostUsd: number;
            /** @description What the run's calls have cost so far, from recorded usage and the price table. */
            actualCostUsd: number;
            counts: {
                total: number;
                /** @description A new result was kept. */
                applied: number;
                /** @description The request failed. The Offer keeps its previous result. */
                failed: number;
                /** @description The spend cap stopped it before it was sent. */
                capped: number;
                /** @description Thrown away: the Offer's words changed while the batch ran, or it is gone. */
                dropped: number;
                /** @description Still waiting for, or inside, a batch. */
                pending: number;
            };
            /** @description Failed or capped Offers by error kind, such as `overloaded` or `spend_cap_reached`; `{}` when none. */
            errorKinds: {
                [key: string]: number;
            };
            /**
             * @description Why a `stopped` run stopped: `spend-cap-reached` (the cap ran out, or was lowered and canceled what was out) or `interrupted` ("Delete all Offer data" removed the Offers it was still reading). Null otherwise.
             * @enum {string|null}
             */
            stopReason: "spend-cap-reached" | "interrupted" | null;
        };
        Storage: {
            database: {
                /** @description The database file with its write-ahead log and shared-memory files, as they are on disk */
                bytes: number;
            };
            /** @description The raw Offer pages in `offer-pages/`: how many files and their bytes */
            snapshots: {
                files: number;
                bytes: number;
            };
            /** @description Pages saved for 'page layout changed?' in `unexpected-pages/` */
            unexpectedPages: {
                files: number;
                bytes: number;
            };
            /** @description Free space on the data folder's disk; null when the system can't say */
            freeBytes: number | null;
            /** @description Offers by state */
            offers: {
                total: number;
                /** @description Neither Stale nor Untracked: they take part in ranking */
                shown: number;
                stale: number;
                /** @description Not Stale, but no enabled Search matches them */
                untracked: number;
                /** @description Stale or Untracked Offers whose record a mark or override keeps from being pruned (also counted above) */
                keptForMarks: number;
            };
            requestLog: {
                rows: number;
            };
            /** @description Fixed constants, not settings */
            retention: {
                /** @description An Offer record is deleted this long after it went Stale or Untracked */
                recordDays: number;
                snapshotDays: number;
                unexpectedPageDays: number;
                requestLogDays: number;
                /** @description Crawling pauses with 'disk nearly full' under this much free */
                lowDiskBytes: number;
                pruneAt: string;
            };
            /** @description ISO 8601 time the last prune that finished started; null if none ever did. `prune` says how the last attempt went. */
            lastPrune: string | null;
            prune: components["schemas"]["StoragePrune"];
            wipe: components["schemas"]["StorageWipe"];
            catchUp: components["schemas"]["StorageCatchUp"];
        };
        /** @description The nightly prune: how its last attempt went and when the next one starts. `lastAttempt` is null when `never`; `lastSuccess` is the last attempt that finished, null if none ever did. A prune that fails is tried again after a backoff, not every minute; what it deleted before it failed is not counted. */
        StoragePrune: {
            /**
             * @description `never`: no attempt has ended yet; the next check, within a minute of the server starting, prunes. `ok`: the last attempt finished. `failing`: the last attempt failed, and so did every one since `failingSince`.
             * @enum {string}
             */
            state: "never" | "ok" | "failing";
            lastAttempt: components["schemas"]["PruneAttempt"];
            lastSuccess: components["schemas"]["PruneAttempt"];
            /** @description ISO 8601 start of the first of the failed attempts in a row; null unless `failing` */
            failingSince: string | null;
            /** @description Failed attempts in a row; 0 unless `failing` */
            failures: number;
            /** @description ISO 8601. The first check at or after this starts the next attempt; checks run every minute, so a time already past means within a minute. After a success it is the next 03:00 Berlin. After a failure it is 15 minutes after that attempt ended, twice as long after each further failure in a row, up to a day. Null when `never`. */
            nextAttemptAt: string | null;
        };
        /** @description One attempt of the nightly prune. `deleted` is what it deleted: null when it failed. */
        PruneAttempt: {
            /** @description ISO 8601 */
            startedAt: string;
            /** @description ISO 8601 time it finished or failed */
            finishedAt: string;
            deleted: components["schemas"]["PruneDeleted"];
            /**
             * @description The kind of error that stopped it; null when it finished. `disk-full`: the disk or the database had no room left. `database-busy`: something else held the database. `database-error`: another error from the database. `unknown`: anything else.
             * @enum {string|null}
             */
            error: "disk-full" | "database-busy" | "database-error" | "unknown" | null;
        } | null;
        PruneDeleted: {
            offers: number;
            snapshots: number;
            unexpectedPages: number;
            requests: number;
        } | null;
        StorageWipe: {
            /** @description "Delete all Offer data" is under way: it waits for the request in flight, then deletes. The counts above are from before it until it is done. Null otherwise. */
            running: {
                /** @description ISO 8601 */
                since: string;
            } | null;
            /** @description The latest wipe; null if there never was one */
            last: {
                /** @description ISO 8601 time the rows were deleted */
                at: string;
                deleted: components["schemas"]["WipeDeleted"];
                /** @description False while the stored pages are still being removed, or after the process stopped before it could: the next start removes them */
                filesRemoved: boolean;
            } | null;
        };
        WipeDeleted: {
            offers: number;
            snapshots: number;
            unexpectedPages: number;
            requests: number;
        };
        /** @description The catch-up this start ran on the Offers already stored: what an earlier start or an older rules version left behind. It runs once per start, in the background, and is always this start's, also when the database would not store it. */
        StorageCatchUp: {
            /**
             * @description `running`: under way in the background. `finished`: every phase ran to its end; items may still have been skipped or have failed. `stopped`: a shutdown came first; the next start begins again. `failed`: at least one phase broke off; the others still ran.
             * @enum {string}
             */
            state: "running" | "finished" | "stopped" | "failed";
            /** @description ISO 8601 */
            startedAt: string;
            /** @description ISO 8601 time it ended, however it ended; null while `running` */
            finishedAt: string | null;
            /** @description In the order they run; each runs whatever became of the one before. `adoptPages`: stored pages whose Offers step never finished become Offers. One that is gone or unreadable is settled, counted as skipped and not looked at again. One whose Offers step threw is counted as failed and tried again at each start, for 7 days from the first start that failed on it; a later start that still throws settles it too, as skipped. `backfillProfiles`: Ad IDs with a missing or outdated dedupe profile get one from their stored page; a skipped one keeps the profile it has. `followCurrent`: an Offer whose card names another Ad ID than its current one takes the current one's page; a skipped one stays on the older page. `reparse`: Offers whose facts an older rules version read are read again from their stored pages; a skipped one keeps the facts the older rules read. What these three skip is counted again at each start. */
            phases: {
                adoptPages: components["schemas"]["CatchUpPhase"];
                backfillProfiles: components["schemas"]["CatchUpPhase"];
                followCurrent: components["schemas"]["CatchUpPhase"];
                reparse: components["schemas"]["CatchUpPhase"];
            };
        };
        /** @description One phase of the catch-up after a start. An item with nothing to catch up on is in none of the counts. */
        CatchUpPhase: {
            /**
             * @description `pending`: not reached, and never will be once the catch-up has ended. `finished`: every item was looked at, and the counts say how each went. `stopped`: a shutdown cut it short. `failed`: it broke off, on an error outside any one item or on one that is the whole database's (locked, full, read-only, unreadable); its counts stop there.
             * @enum {string}
             */
            state: "pending" | "running" | "finished" | "stopped" | "failed";
            /** @description ISO 8601; null while `pending` */
            startedAt: string | null;
            /** @description ISO 8601 time it ended, however it ended; null until then */
            finishedAt: string | null;
            /** @description Items brought up to date */
            done: number;
            /** @description Items left as they are because it can't be done: their page is deleted, gone from the data folder or unreadable */
            skipped: number;
            /** @description Items that threw for a reason of their own. Each is left as it is and tried again at the next start, and the phase went on with the next item. */
            failed: number;
        };
        WipeResult: {
            deleted: components["schemas"]["WipeDeleted"];
            storage: components["schemas"]["Storage"];
        };
        WipeRequest: {
            /**
             * @description Must be exactly "delete all Offer data". Without it nothing is deleted.
             * @enum {string}
             */
            confirm: "delete all Offer data";
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;

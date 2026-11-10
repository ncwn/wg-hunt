export const SOURCES = ["wg-gesucht"] as const;
export type Source = (typeof SOURCES)[number];
export const DEFAULT_SOURCE: Source = "wg-gesucht";

export const CATEGORIES = ["flatshare-room", "one-room-flat", "flat", "house"] as const;
export type Category = (typeof CATEGORIES)[number];

export const RENT_TYPES = ["unlimited", "limited", "overnight"] as const;
export type RentType = (typeof RENT_TYPES)[number];

export const MAX_RECENCY_DAYS = 7;

export const DEFAULT_POLL_INTERVAL = { minMinutes: 30, maxMinutes: 60 } as const;
export const MIN_POLL_MINUTES = 15;
export const MAX_POLL_MINUTES = 24 * 60;

import type { RuleFacts } from "../offer-facts/index.js";
import type { Category, RentType, Source } from "../searches.js";

export type ParseContext = {
  firstSeen: Date;
  /** Wins over the parser's own reading of the page. */
  category?: Category;
};

/** `deactivated`: the Advertiser paused it, and the page still shows the Offer. */
export const PAGE_STATUSES = ["active", "deactivated", "deleted"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

/** "Online:" is either a relative age (time since the last publish or Bump) or a date. */
export type OnlineAge = { kind: "relative"; minutes: number } | { kind: "date"; date: string };

/** As the Advertiser wrote them, never the machine translation. */
export type OfferText = {
  title: string;
  sections: { label: string; text: string }[];
};

export type ParseResult =
  /** Layout changed, or not an Offer page: fail closed. */
  | { outcome: "unexpected"; reason: string; rulesVersion: number }
  | { outcome: "parsed"; status: "deleted"; rulesVersion: number }
  | {
      outcome: "parsed";
      status: Exclude<PageStatus, "deleted">;
      rulesVersion: number;
      adId?: string;
      category: Category;
      text: OfferText;
      /** Absent when the page shows no activity, as on a deactivated Offer. */
      online?: OnlineAge;
      facts: RuleFacts;
    };

export type SearchSpec = {
  city: string;
  /** Needed for cities the adapter doesn't know. */
  cityId: string | null;
  categories: readonly Category[];
  rentTypes: readonly RentType[];
  /** Loose ceiling on warm rent per month, in euros. */
  priceCeiling: number | null;
  /** 1-7 days since the Offer was published or Bumped. */
  recencyDays: number;
};

type SearchPageRequest = {
  category: Category;
  path: string;
};

export type SearchPageRequests =
  | { ok: true; requests: SearchPageRequest[] }
  | { ok: false; reason: "unknown-city" };

/** `pro` is a private person with a paid PRO account. */
export type AdvertiserKind = "private" | "pro" | "company";

/** The unit the Source showed the age in: the true age is within one unit above it. */
export type CardOnline = { age: OnlineAge; unitMinutes: number };

export type SearchCard = {
  adId: string;
  path: string;
  title: string;
  rent?: { amount: number; unit: "month" | "night" };
  /** Square metres; a flatshare room's own size, a flat's whole size. */
  size?: number;
  /** The Offer page has no private name, and no badge. */
  advertiser: { name?: string; avatarUrl?: string; kind?: AdvertiserKind };
  online?: CardOnline;
};

export type SearchPageResult =
  | { outcome: "unexpected"; reason: string }
  | {
      outcome: "results";
      /** One per Ad ID, in page order. Promoted placements are left out. */
      cards: SearchCard[];
      promoted: number;
    };

/** Everything specific to a site lives in its adapter; nothing else in core knows a site by name. */
export interface SourceAdapter {
  readonly id: Source;
  readonly rulesVersion: number;
  parseOffer(html: string, ctx: ParseContext): ParseResult;
  /** `page` is 0-based. A path never uses a parameter the Source ignores. */
  searchPages(search: SearchSpec, page: number): SearchPageRequests;
  parseSearchPage(html: string): SearchPageResult;
  offerUrl(path: string): string;
  /** Null when it is not an Offer page of this Source. */
  adIdFromUrl(url: string): string | null;
}

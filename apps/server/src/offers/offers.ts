import {
  type AdProfile,
  profileOf as adProfileOf,
  applicabilityContext,
  type Band,
  type Category,
  checkOverride,
  compareKeys,
  contentHash,
  distanceToPlace,
  type Fact,
  findPlace,
  isApplicable,
  isPageFailure,
  type ModelFacts,
  type OfferText,
  type OrderKey,
  orderKey,
  type PageStatus,
  type Place,
  policyOf,
  type RuleFacts,
  rankOffer,
  type ScamAssessment,
  type SearchCard,
  type Seeking,
  type Sort,
  type Source,
  type SourceAdapter,
} from "@wg-hunt/core";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { carryWaiting, WAITING } from "../analysis/batch-state.js";
import { keyState } from "../analysis/key.js";
import {
  type AnalysisFailure,
  type AnalysisRun,
  type OwedEscalation,
  parseStoredAnalysis,
} from "../analysis/record.js";
import {
  type AnalysisStatus,
  type AnalysisStatusInput,
  type AnalysisStatusKind,
  countByStatus,
  deriveAnalysisStatus,
} from "../analysis/status.js";
import { analysisVersion, onOlderAnalysis } from "../analysis/version.js";
import { loadAnalysisSettings } from "../analysis-settings.js";
import { type RecheckState, recheckStateOf } from "../crawl/rechecks.js";
import type { FetchedOffer } from "../crawl/search-polls.js";
import type { SnapshotStore } from "../crawl/snapshots.js";
import type { Db } from "../db/index.js";
import {
  analysisItems,
  type OfferAdRow,
  type OfferRow,
  offerAds,
  offerLinks,
  offerPrices,
  offers,
  offerTexts,
  offerTombstones,
  seenAds,
} from "../db/schema.js";
import type { EventBus } from "../events.js";
import { isPairPinned, refreshOfferClocks } from "../retention/clocks.js";
import { type OfferRetention, offerRetention } from "../retention/view.js";
import { loadSeeking } from "../seeking.js";
import { cardKey } from "./card-key.js";
import { mergedRow, readDepth, splitRow } from "./carry-over.js";
import {
  ADOPT_RETRY_DAYS,
  type AdoptFailures,
  type CatchUpStep,
  eachItem,
  errorKind,
  isDatabaseWide,
  readAdoptFailures,
  saveAdoptFailures,
} from "./catch-up.js";
import { createDedupeStore, profileOutdated } from "./dedupe.js";
import { createFactOverrides, type MadeOn } from "./fact-overrides.js";
import { factsOf, type RankedEntry, type RankingView, rankableOf } from "./ranking.js";
import { createScamContext } from "./scam.js";
import { isAdStale, isOfferStale, STALE_AFTER_DAYS } from "./staleness.js";
import { readStoredPage } from "./stored-page.js";
import { trackedAds, adKey as trackedKey } from "./tracked.js";
import { visibilityOf } from "./visibility.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * So band moves only time causes (going Stale, a Scam rent baseline moving) are recorded without
 * anyone reading.
 */
export const REBAND_EVERY_MS = 5 * MINUTE;
const REBAND_CHECK_MS = MINUTE;

export type AnalysisState = "pending" | "analyzed" | "failed";

type Money = { amount: number; converted: boolean };

type OfferAd = {
  source: Source;
  adId: string;
  url: string;
  firstSeenAt: string;
  lastBumpAt: string | null;
  pageStatus: PageStatus;
  current: boolean;
  textHash: string | null;
};

export type TextVersion = {
  source: Source;
  adId: string;
  seenAt: string;
  /** Same fingerprint as `OfferAd.textHash`. */
  hash: string;
  title: string;
  sections: { label: string; text: string }[];
};

export type RelatedOffer = {
  offer: OfferSummary;
  sharedImages: number;
  textSimilarity: number | null;
};

/** `copy` came after `original`. */
export type ClonedOffer = RelatedOffer & { role: "original" | "copy" };

export type IngestResult = {
  /** `none`: a deleted page, which makes no Offer. */
  outcome: "created" | "merged" | "refreshed" | "none";
  offerId: number | null;
  /** The Ad ID re-posts words already read (same `.original_content` hash): no model pass. */
  reusedFacts: boolean;
};

type Marks = { dismissed: boolean; shortlisted: boolean; contacted: boolean };

export type MarksChange = Partial<Marks> & { scam?: "scam" | "not" | "clear" };

export type OfferCounts = { bands: Record<Band, number>; new: number };

export type OfferSummary = RankingView & {
  id: number;
  category: Category;
  title: string;
  url: string;
  /** Shown to people; not what "new" means. */
  firstSeenAt: string;
  /** `?since=` follows this (and `bandChangedAt`); the list order does not. */
  createdAt: string;
  updatedAt: string;
  lastBumpAt: string | null;
  pageStatus: PageStatus;
  stale: boolean;
  /** An untracked Offer is hidden but not Stale: it may be live. */
  tracked: boolean;
  analysisState: AnalysisState;
  analysisStatus: AnalysisStatus;
  marks: Marks;
  /**
   * Straight-line distance to the Place a list is sorted by; null in other lists or with neither
   * coordinates nor a known PLZ. `approximate` when the PLZ centre stood in for coordinates.
   */
  distance: { place: string; km: number; approximate: boolean } | null;
  keyFacts: {
    warmRent: Money | null;
    /** The room (flatshare) or the whole home, in square metres. */
    size: number | null;
    district: string | null;
    availableFrom: string | null;
  };
};

type FactView = Pick<Fact<unknown>, "value" | "origin" | "quote" | "alternatives" | "confidence">;

export type AnalysisView = {
  state: AnalysisState;
  /** What the last successful analysis ran with; null while nothing has succeeded. */
  model: string | null;
  effort: AnalysisRun["effort"] | null;
  escalation: AnalysisRun["escalation"];
  escalated: boolean;
  analyzedAt: string | null;
  analysisVersion: string | null;
  olderVersion: boolean;
  log: AnalysisRun["log"];
};

export type AnalysisJob = {
  id: number;
  category: Category;
  source: Source;
  adId: string;
  adFirstSeenAt: Date;
  adCategory: Category | null;
  state: AnalysisState;
  /** Never analysed. */
  stale: boolean;
  wordsChanged: boolean;
  contentHash: string | null;
  /** Into `contentHash`. */
  readDepth: 0 | 1 | 2;
  /** Null before versions existed or while nothing is stored. */
  analysisVersion: string | null;
  /** Epoch ms. */
  lastBumpAt: number | null;
  failure: { kind: string; at: number; attempts: number; contentHash: string | null } | null;
  ranWith: { model: string; effort: AnalysisRun["effort"] } | null;
  /** Null when final or nothing is stored. */
  escalation: OwedEscalation | null;
  /** Epoch ms. A click is read whatever the Offer's state. */
  reanalyzeRequestedAt: number | null;
};

export type OfferDetail = OfferSummary & {
  ads: OfferAd[];
  advertiser: {
    name: string | null;
    avatarUrl: string | null;
    kind: NonNullable<SearchCard["advertiser"]["kind"]> | null;
  };
  /** On the Source; wg-hunt never downloads an image. */
  photos: string[];
  facts: Record<string, FactView | FactView[]>;
  analysis: AnalysisView;
  priceHistory: {
    observedAt: string;
    source: Source;
    adId: string;
    warmRent: number;
    converted: boolean;
  }[];
  textHistory: TextVersion[];
  rulesVersion: number;
  siblings: RelatedOffer[];
  cloned: ClonedOffer[];
  scam: ScamAssessment;
  overrides: string[];
  corrections: ({ key: string; createdAt: string } & Provenance)[];
  recheck: RecheckState;
  retention: OfferRetention;
};

export type OverrideProblem = "not-found" | { invalid: string };

/** Null when the correction was made before this was recorded. */
type CorrectionPage = { source: Source; adId: string; textHash: string | null } | null;

type Provenance = {
  madeOn: CorrectionPage;
  /** Null when either side's words are not known. */
  wordsChanged: boolean | null;
};

export type OverrideListing = {
  offerId: number;
  source: Source;
  adId: string;
  key: string;
  value: unknown;
  createdAt: string;
  adCount: number;
} & Provenance;

export type OfferCursor = OrderKey;

export type ListQuery = {
  /** Offers that were made, or entered their current band, after this time. */
  since?: Date | undefined;
  category?: Category | undefined;
  /** Only this band. Without it, every band but Hidden (Hidden too with `includeHidden`). */
  band?: Band | undefined;
  includeHidden?: boolean | undefined;
  /** Only shortlisted Offers, from every band (Hidden too) unless `band` names one. */
  shortlisted?: boolean | undefined;
  sort: Sort;
  /** The Place a `distance` sort measures to, by name; the profile's first Place when left out. */
  place?: string | undefined;
  after?: OfferCursor | undefined;
  limit: number;
};

export type RankingPreview = {
  changes: { offerId: number; title: string; from: Band; to: Band }[];
  counts: { before: Record<Band, number>; after: Record<Band, number> };
};

const PAGE_RANK: Record<PageStatus, number> = { active: 0, deactivated: 1, deleted: 2 };

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

function stated<T>(facts: RuleFacts, key: keyof RuleFacts): T | null {
  const fact = facts[key] as Fact<T> | undefined;
  return fact === undefined || fact.value === "unknown" ? null : (fact.value as T);
}

/** Photo addresses are shown by the browser, so only plain web addresses pass. */
const isWebAddress = (text: unknown): text is string =>
  typeof text === "string" && /^https?:\/\//i.test(text);

export type Offers = ReturnType<typeof createOffers>;

export type AnalysisContext = {
  reading: (offerId: number) => boolean;
  unstored: (offerId: number) => boolean;
  cap: () => AnalysisStatusInput["cap"];
  noRoom: () => ReadonlySet<number>;
  announce: (offerId: number) => void;
};

type AnalysisSnapshot = {
  held: Map<number, { stage: 1 | 2; since: Date }>;
  key: ReturnType<typeof keyState>;
  cap: AnalysisStatusInput["cap"];
  noRoom: ReadonlySet<number>;
  version: string;
  now: number;
};

export function createOffers(deps: {
  db: Db;
  adapters: Record<Source, SourceAdapter>;
  snapshots: Pick<SnapshotStore, "read">;
  /** Epoch milliseconds. */
  clock: () => number;
  events?: EventBus;
}) {
  const { db, adapters, snapshots, clock, events } = deps;
  const dedupe = createDedupeStore(db, clock);
  const factOverrides = createFactOverrides(db, clock);
  let stopped = false;
  let reparsing: Promise<CatchUpStep> | undefined;
  let lastRebandAll: number | undefined;
  let rebandTimer: NodeJS.Timeout | undefined;

  const adsOf = (offerIds: number[]): Map<number, OfferAdRow[]> => {
    const byOffer = new Map<number, OfferAdRow[]>();
    if (offerIds.length === 0) return byOffer;
    for (const ad of db.select().from(offerAds).where(inArray(offerAds.offerId, offerIds)).all()) {
      byOffer.set(ad.offerId, [...(byOffer.get(ad.offerId) ?? []), ad]);
    }
    return byOffer;
  };

  /** The Ad ID whose page gives the Offer its facts, title, card, link and Recheck. */
  function currentAd(ads: OfferAdRow[]): OfferAdRow {
    const [first] = [...ads].sort(
      (a, b) =>
        PAGE_RANK[a.pageStatus] - PAGE_RANK[b.pageStatus] ||
        (b.lastBumpAt?.getTime() ?? -Infinity) - (a.lastBumpAt?.getTime() ?? -Infinity) ||
        b.firstSeenAt.getTime() - a.firstSeenAt.getTime() ||
        b.adId.localeCompare(a.adId),
    );
    if (first === undefined) throw new Error("an Offer always has an Ad ID");
    return first;
  }

  const urlOf = (ad: OfferAdRow) => adapters[ad.source].offerUrl(ad.path);

  const tracking = (onlyOffer?: number) => trackedAds(db, onlyOffer);

  function summaryOf(
    { row, ads, ranking, bandChangedAt, tracked, rankable, visibility }: RankedEntry,
    measureTo?: Place,
    analysisNow: AnalysisSnapshot = analysisSnapshot(),
  ): OfferSummary {
    const current = currentAd(ads);
    // What the key facts show is the effective facts: a correction the seeker made counts.
    const facts = rankable.facts as unknown as RuleFacts;
    const away = measureTo && distanceToPlace(rankable.facts, measureTo);
    return {
      id: row.id,
      category: row.category,
      title: row.title,
      url: urlOf(current),
      firstSeenAt: row.firstSeenAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastBumpAt: iso(current.lastBumpAt),
      pageStatus: ads.some((ad) => ad.pageStatus === "active")
        ? "active"
        : ads.some((ad) => ad.pageStatus === "deactivated")
          ? "deactivated"
          : "deleted",
      stale: rankable.stale === true,
      tracked,
      analysisState: row.analysisState,
      analysisStatus: statusOf(row, ads, analysisNow),
      marks: { dismissed: row.dismissed, shortlisted: row.shortlisted, contacted: row.contacted },
      distance:
        measureTo && away
          ? {
              place: measureTo.name,
              km: Math.round(away.km * 100) / 100,
              approximate: away.approximate,
            }
          : null,
      band: ranking.band,
      bandChangedAt: bandChangedAt.toISOString(),
      reasons: ranking.reasons,
      chips: ranking.chips,
      hiddenBecause: ranking.hiddenBecause ?? null,
      visibility,
      keyFacts: {
        warmRent: stated<Money>(facts, "warmRent"),
        size: stated<number>(facts, "roomSize"),
        district: stated<string>(facts, "district"),
        availableFrom: stated<string>(facts, "availableFrom"),
      },
    };
  }

  function analysisView(row: OfferRow, ads: OfferAdRow[]): AnalysisView {
    const stored = parseStoredAnalysis(row.analysis);
    const job = jobOf(row, ads);
    const settings = loadAnalysisSettings(db);
    const current = analysisVersion({ model: settings.model, effort: settings.effort });
    return {
      state: row.analysisState,
      model: stored.run?.model ?? null,
      effort: stored.run?.effort ?? null,
      escalation: stored.run?.escalation ?? null,
      escalated: stored.run?.escalated ?? false,
      analyzedAt: stored.run?.analyzedAt ?? null,
      analysisVersion: job?.analysisVersion ?? null,
      olderVersion: job !== undefined && onOlderAnalysis(job, current),
      log: stored.run?.log ?? [],
    };
  }

  function textHistoryOf(offerId: number): TextVersion[] {
    return db
      .select({ version: offerTexts })
      .from(offerTexts)
      .innerJoin(
        offerAds,
        and(eq(offerAds.source, offerTexts.source), eq(offerAds.adId, offerTexts.adId)),
      )
      .where(eq(offerAds.offerId, offerId))
      .orderBy(offerTexts.seenAt, offerTexts.adId)
      .all()
      .map(({ version }) => ({
        source: version.source,
        adId: version.adId,
        seenAt: version.seenAt.toISOString(),
        hash: version.contentHash,
        title: version.title,
        sections: JSON.parse(version.sections) as OfferText["sections"],
      }));
  }

  function detailOf(entry: RankedEntry): OfferDetail {
    const { row, ads } = entry;
    const current = currentAd(ads);
    const facts = JSON.parse(row.facts) as RuleFacts;
    const card = JSON.parse(row.card) as SearchCard;
    const photos = stated<unknown[]>(facts, "imageUrls") ?? [];
    return {
      ...summaryOf(entry),
      ads: [...ads]
        .sort(
          (a, b) =>
            a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || a.adId.localeCompare(b.adId),
        )
        .map((ad) => ({
          source: ad.source,
          adId: ad.adId,
          url: urlOf(ad),
          firstSeenAt: ad.firstSeenAt.toISOString(),
          lastBumpAt: iso(ad.lastBumpAt),
          pageStatus: ad.pageStatus,
          current: ad.adId === current.adId && ad.source === current.source,
          textHash: ad.contentHash,
        })),
      advertiser: {
        name: card.advertiser.name ?? null,
        avatarUrl: isWebAddress(card.advertiser.avatarUrl) ? card.advertiser.avatarUrl : null,
        kind: card.advertiser.kind ?? null,
      },
      photos: photos.filter(isWebAddress),
      facts: Object.fromEntries(
        Object.entries(entry.rankable.facts).flatMap(([key, fact]) =>
          fact === undefined || key === "category" ? [] : [[key, fact as FactView | FactView[]]],
        ),
      ),
      overrides: entry.overrides.map((override) => override.key).sort(),
      corrections: factOverrides.all(row.id).map((override) => ({
        key: override.key,
        createdAt: override.createdAt.toISOString(),
        ...provenanceOf(override.madeOn, current),
      })),
      analysis: analysisView(row, ads),
      priceHistory: db
        .select()
        .from(offerPrices)
        .where(eq(offerPrices.offerId, row.id))
        .orderBy(offerPrices.observedAt, offerPrices.id)
        .all()
        .map((price) => ({
          observedAt: price.observedAt.toISOString(),
          source: price.source,
          adId: price.adId,
          warmRent: price.amount,
          converted: price.converted,
        })),
      textHistory: textHistoryOf(row.id),
      rulesVersion: row.rulesVersion,
      ...relatedOffers(row.id, ads),
      scam: entry.rankable.scam,
      recheck: recheckStateOf(db, current, clock()),
      retention: offerRetention(db, row.id, clock()) as OfferRetention,
    };
  }

  /**
   * Links are kept per Ad ID; those between two Ad IDs of one Offer, left by a merge, are ignored.
   */
  function relatedOffers(
    offerId: number,
    ads: OfferAdRow[],
  ): { siblings: RelatedOffer[]; cloned: ClonedOffer[] } {
    const mine = new Set(ads.map((ad) => `${ad.source}:${ad.adId}`));
    const links = db
      .select()
      .from(offerLinks)
      .where(
        or(
          inArray(
            offerLinks.adId,
            ads.map((ad) => ad.adId),
          ),
          inArray(
            offerLinks.otherAdId,
            ads.map((ad) => ad.adId),
          ),
        ),
      )
      .all()
      .filter(
        (link) =>
          mine.has(`${link.source}:${link.adId}`) || mine.has(`${link.source}:${link.otherAdId}`),
      );
    if (links.length === 0) return { siblings: [], cloned: [] };

    const others = links.map((link) =>
      mine.has(`${link.source}:${link.adId}`) ? link.otherAdId : link.adId,
    );
    const otherOffer = new Map(
      db
        .select()
        .from(offerAds)
        .where(inArray(offerAds.adId, others))
        .all()
        .map((ad) => [`${ad.source}:${ad.adId}`, ad.offerId] as const),
    );

    const found = new Map<
      string,
      Omit<RelatedOffer, "offer"> & { kind: string; copy: boolean; offerId: number }
    >();
    for (const link of links) {
      const iAmLater = mine.has(`${link.source}:${link.adId}`);
      const otherAd = iAmLater ? link.otherAdId : link.adId;
      const other = otherOffer.get(`${link.source}:${otherAd}`);
      if (other === undefined || other === offerId) continue;
      const key = `${link.kind}:${other}`;
      const seen = found.get(key);
      const strongerThanSeen =
        seen === undefined ||
        link.sharedImages > seen.sharedImages ||
        (link.sharedImages === seen.sharedImages &&
          (link.textSimilarity ?? 0) > (seen.textSimilarity ?? 0));
      found.set(key, {
        kind: link.kind,
        offerId: other,
        copy: (seen?.copy ?? false) || iAmLater,
        sharedImages: strongerThanSeen ? link.sharedImages : (seen?.sharedImages ?? 0),
        textSimilarity: strongerThanSeen ? link.textSimilarity : (seen?.textSimilarity ?? null),
      });
    }

    const summaries = new Map<number, OfferSummary>();
    const offerRows = db
      .select()
      .from(offers)
      .where(inArray(offers.id, [...new Set([...found.values()].map((entry) => entry.offerId))]))
      .all();
    const adsByOffer = adsOf(offerRows.map((row) => row.id));
    const now = clock();
    const related = rankRows(offerRows, adsByOffer, loadSeeking(db), now);
    remember(related, now);
    const analysisNow = analysisSnapshot();
    for (const entry of related)
      summaries.set(entry.row.id, summaryOf(entry, undefined, analysisNow));

    const entries = [...found.values()]
      .flatMap((entry) => {
        const offer = summaries.get(entry.offerId);
        return offer === undefined ? [] : [{ ...entry, offer }];
      })
      .sort((a, b) => a.offerId - b.offerId);
    return {
      siblings: entries
        .filter((entry) => entry.kind === "sibling")
        .map(({ offer, sharedImages, textSimilarity }) => ({
          offer,
          sharedImages,
          textSimilarity,
        })),
      cloned: entries
        .filter((entry) => entry.kind === "cloned")
        .map(({ offer, sharedImages, textSimilarity, copy }) => ({
          offer,
          sharedImages,
          textSimilarity,
          role: copy ? ("copy" as const) : ("original" as const),
        })),
    };
  }

  const allAds = (): Map<number, OfferAdRow[]> => {
    const byOffer = new Map<number, OfferAdRow[]>();
    for (const ad of db.select().from(offerAds).all()) {
      byOffer.set(ad.offerId, [...(byOffer.get(ad.offerId) ?? []), ad]);
    }
    return byOffer;
  };

  /** Pure: nothing is saved. */
  function rankRows(
    rows: OfferRow[],
    adsByOffer: Map<number, OfferAdRow[]>,
    seeking: Seeking,
    now: number,
    tracked: { offers: Set<number>; ads: Set<string> } = tracking(),
  ): RankedEntry[] {
    // Derived Scam signals depend on the other Offers, so they are worked out on every pass.
    const corrections = factOverrides.forOffers();
    const scams = createScamContext(db, now, corrections);
    return rows.flatMap((row) => {
      const ads = adsByOffer.get(row.id);
      if (ads === undefined || ads.length === 0) return [];
      const isTracked = tracked.offers.has(row.id);
      const overrides = corrections.get(row.id) ?? [];
      const current = currentAd(ads);
      const rankable = rankableOf(row, ads, current, now, isTracked, scams, overrides);
      const ranking = rankOffer(rankable, seeking);
      return [
        {
          row,
          ads,
          rankable,
          tracked: isTracked,
          bandToRemember: isTracked
            ? ranking.band
            : rankOffer({ ...rankable, untracked: false }, seeking).band,
          visibility: visibilityOf({
            row,
            ads,
            flags: rankable,
            currentTracked: tracked.ads.has(trackedKey(current.source, current.adId)),
            now,
          }),
          overrides,
          ranking,
          bandChangedAt: row.bandChangedAt ?? row.createdAt,
        },
      ];
    });
  }

  /**
   * Only Tracked Offers announce a move (an untracked one shows Hidden whatever is stored). Every
   * read calls this, so a move only time causes is never shown unstored.
   */
  function remember(entries: RankedEntry[], now: number): number {
    const moved: { offerId: number; band: Band; previousBand: Band; at: Date }[] = [];
    let changed = 0;
    db.$client.transaction(() => {
      for (const entry of entries) {
        const { row, bandToRemember: band } = entry;
        if (row.band === band) continue;
        const at = row.band === null ? row.createdAt : new Date(now);
        db.update(offers).set({ band, bandChangedAt: at }).where(eq(offers.id, row.id)).run();
        entry.bandChangedAt = at;
        entry.row = { ...row, band, bandChangedAt: at };
        if (row.band === null) continue;
        changed++;
        if (entry.tracked) moved.push({ offerId: row.id, band, previousBand: row.band, at });
      }
    })();
    announce(moved);
    return changed;
  }

  /** Inside a caller's transaction, moves go out after it ends, and only if it committed. */
  function announce(moved: { offerId: number; band: Band; previousBand: Band; at: Date }[]): void {
    if (moved.length === 0 || events === undefined) return;
    const publish = (check: boolean) => {
      for (const { offerId, band, previousBand, at } of moved) {
        if (check) {
          const now = db
            .select({ band: offers.band, at: offers.bandChangedAt })
            .from(offers)
            .where(eq(offers.id, offerId))
            .get();
          if (now?.band !== band || now.at?.getTime() !== at.getTime()) continue;
        }
        events.publish("offer-band-changed", {
          offerId,
          band,
          previousBand,
          bandChangedAt: at.toISOString(),
        });
      }
    };
    // better-sqlite3 transactions are synchronous: by the next microtask the outer one has ended.
    if (db.$client.inTransaction) queueMicrotask(() => publish(true));
    else publish(false);
  }

  function reband(id: number): RankedEntry | undefined {
    const row = db.select().from(offers).where(eq(offers.id, id)).get();
    if (row === undefined) return undefined;
    const now = clock();
    const [entry] = rankRows([row], adsOf([id]), loadSeeking(db), now, tracking(id));
    if (entry !== undefined) remember([entry], now);
    return entry;
  }

  function rebanded(id: number): OfferDetail | undefined {
    const entry = reband(id);
    return entry && detailOf(entry);
  }

  function rebandAll(): number {
    const now = clock();
    const rows = db.select().from(offers).all();
    const moved = remember(rankRows(rows, allAds(), loadSeeking(db), now), now);
    lastRebandAll = now;
    return moved;
  }

  function tick(): number | undefined {
    if (lastRebandAll !== undefined && clock() - lastRebandAll < REBAND_EVERY_MS) return undefined;
    return rebandAll();
  }

  const countBands = (entries: RankedEntry[]): Record<Band, number> => {
    const counts: Record<Band, number> = { match: 0, "near-match": 0, warned: 0, hidden: 0 };
    for (const entry of entries) counts[entry.ranking.band]++;
    return counts;
  };

  /** `before` is what `GET /offers/counts` says: a move time caused is recorded first. */
  function preview(draft: Seeking): RankingPreview {
    const now = clock();
    const rows = db.select().from(offers).all();
    const ads = allAds();
    const before = rankRows(rows, ads, loadSeeking(db), now);
    remember(before, now);
    const after = new Map(rankRows(rows, ads, draft, now).map((entry) => [entry.row.id, entry]));
    const changes = before
      .flatMap((entry) => {
        const next = after.get(entry.row.id);
        return next !== undefined && next.ranking.band !== entry.ranking.band
          ? [{ entry, to: next.ranking.band }]
          : [];
      })
      .sort((a, b) => b.entry.rankable.firstSeenAt - a.entry.rankable.firstSeenAt)
      .map(({ entry, to }) => ({
        offerId: entry.row.id,
        title: entry.row.title,
        from: entry.ranking.band,
        to,
      }));
    return {
      changes,
      counts: { before: countBands(before), after: countBands([...after.values()]) },
    };
  }

  /**
   * Paging is by sort-key cursor, so an Offer that moves between pages can be listed twice or
   * skipped until the next walk from the top.
   */
  function list(query: ListQuery): { items: OfferSummary[]; nextKey: OfferCursor | null } {
    const { since, category, band, includeHidden, shortlisted, sort, place, after, limit } = query;
    const { entries, seeking } = rankedNow(category);
    const measureTo =
      sort === "distance"
        ? place === undefined
          ? seeking.profile.places[0]
          : findPlace(seeking.profile.places, place)
        : undefined;

    const keyed = entries
      .filter((entry) => {
        const here = entry.ranking.band;
        if (shortlisted && !entry.row.shortlisted) return false;
        const listsHidden = includeHidden || shortlisted;
        if (band !== undefined ? here !== band : here === "hidden" && !listsHidden) return false;
        return isNewSince(entry, since);
      })
      // The id ends the key, newest first, so the order is total and a cursor is exact.
      .map((entry) => ({
        entry,
        key: [
          ...orderKey(entry.rankable, entry.ranking, sort, seeking, measureTo?.name),
          -entry.row.id,
        ],
      }))
      .sort((a, b) => compareKeys(a.key, b.key));
    const start = after === undefined ? 0 : keyed.findIndex((k) => compareKeys(k.key, after) > 0);
    const page = start === -1 ? [] : keyed.slice(start, start + limit);
    const last = page.at(-1);
    const analysisNow = analysisSnapshot();
    return {
      items: page.map(({ entry }) => summaryOf(entry, measureTo, analysisNow)),
      nextKey: last !== undefined && start + limit < keyed.length ? last.key : null,
    };
  }

  /**
   * The list and the counts both read through this, so they never disagree about a band; moves
   * only time caused are recorded here, so `bandChangedAt` and `?since=` agree with the band.
   */
  function rankedNow(category?: Category): { entries: RankedEntry[]; seeking: Seeking } {
    const rows = db
      .select()
      .from(offers)
      .where(category && eq(offers.category, category))
      .all();
    const seeking = loadSeeking(db);
    const now = clock();
    const entries = rankRows(rows, allAds(), seeking, now);
    remember(entries, now);
    return { entries, seeking };
  }

  const isNewSince = (entry: RankedEntry, since: Date | undefined) =>
    since === undefined || entry.row.createdAt > since || entry.bandChangedAt > since;

  function counts(since?: Date): OfferCounts {
    const { entries } = rankedNow();
    return {
      bands: countBands(entries),
      new: entries.filter((e) => e.ranking.band !== "hidden" && isNewSince(e, since)).length,
    };
  }

  function get(id: number): OfferDetail | undefined {
    const entry = reband(id);
    return entry && detailOf(entry);
  }

  /**
   * The one way to write what keeps an Offer's record: a mark, a fact override, a pin release.
   * Otherwise only the nightly prune looks at the clocks, and a mark put on and taken off between
   * two prunes would leave the old clock running. The refresh before `write` stops a clock still
   * stored from before something kept the record; the one after starts the 90 days now when
   * nothing keeps it any more.
   */
  function writeWhatKeeps<T>(id: number, write: (now: Date) => T): T {
    const now = clock();
    refreshOfferClocks(db, id, now);
    const written = write(new Date(now));
    refreshOfferClocks(db, id, now);
    return written;
  }

  function setMarks(id: number, change: MarksChange): OfferDetail | undefined {
    const { scam, ...marks } = change;
    const changed = writeWhatKeeps(
      id,
      (now) =>
        db
          .update(offers)
          .set({
            ...marks,
            // Dismissing a Dismissed Offer again keeps when it was first dismissed.
            ...(marks.dismissed !== undefined && {
              dismissedAt: marks.dismissed
                ? sql`coalesce(${offers.dismissedAt}, ${now.getTime()})`
                : null,
            }),
            ...(scam !== undefined && { scamMark: scam === "clear" ? null : scam }),
            updatedAt: now,
          })
          .where(eq(offers.id, id))
          .run().changes,
    );
    return changed === 0 ? undefined : rebanded(id);
  }

  function releasePairPins(id: number): OfferDetail | undefined {
    // The pin held until now, so the record's clock was not running. A clock a merge carried
    // over, which no prune has seen pinned yet, is one the refresh before the write stops.
    const changed = writeWhatKeeps(
      id,
      (now) =>
        db
          .update(offers)
          .set({ pairPinsReleasedAt: now, updatedAt: now })
          .where(eq(offers.id, id))
          .run().changes,
    );
    return changed === 0 ? undefined : get(id);
  }

  function setFactOverride(
    id: number,
    key: string,
    value: unknown,
  ): { ok: true; offer: OfferDetail } | { ok: false; problem: OverrideProblem } {
    const row = db.select().from(offers).where(eq(offers.id, id)).get();
    if (row === undefined) return { ok: false, problem: "not-found" };
    const checked = checkOverride(key, value);
    if (!checked.ok) return { ok: false, problem: { invalid: checked.message } };

    // Whether a fact applies can depend on the Offer being offered as a WG, which an override can say.
    const others = (factOverrides.forOffers([id]).get(id) ?? []).filter((o) => o.key !== key);
    const context = applicabilityContext(factsOf(row, [...others, { key, value: checked.value }]));
    if (!isApplicable(key, row.category, context)) {
      return { ok: false, problem: { invalid: `${key} does not apply to this kind of Offer` } };
    }

    const ads = adsOf([id]).get(id) ?? [];
    const current = ads.length > 0 ? currentAd(ads) : undefined;
    const madeOn = current && {
      source: current.source,
      adId: current.adId,
      contentHash: current.contentHash,
    };
    return overridden(id, () => factOverrides.set(id, key, checked.value, madeOn ?? null));
  }

  function clearFactOverride(
    id: number,
    key: string,
  ): { ok: true; offer: OfferDetail } | { ok: false; problem: "not-found" } {
    if (db.select().from(offers).where(eq(offers.id, id)).get() === undefined) {
      return { ok: false, problem: "not-found" };
    }
    return overridden(id, () => factOverrides.clear(id, key));
  }

  function overridden(
    id: number,
    write: () => void,
  ): { ok: true; offer: OfferDetail } | { ok: false; problem: "not-found" } {
    writeWhatKeeps(id, (now) => {
      write();
      db.update(offers).set({ updatedAt: now }).where(eq(offers.id, id)).run();
    });
    const offer = rebanded(id);
    return offer === undefined ? { ok: false, problem: "not-found" } : { ok: true, offer };
  }

  function provenanceOf(madeOn: MadeOn | null, current: OfferAdRow): Provenance {
    if (madeOn === null) return { madeOn: null, wordsChanged: null };
    const { source, adId, contentHash: textHash } = madeOn;
    return {
      madeOn: { source, adId, textHash },
      wordsChanged:
        textHash === null || current.contentHash === null ? null : textHash !== current.contentHash,
    };
  }

  function listFactOverrides(): OverrideListing[] {
    const all = factOverrides.all();
    const ads = adsOf([...new Set(all.map((o) => o.offerId))]);
    return all.flatMap((override): OverrideListing[] => {
      const offerAds = ads.get(override.offerId);
      if (offerAds === undefined || offerAds.length === 0) return [];
      const current = currentAd(offerAds);
      return [
        {
          offerId: override.offerId,
          source: current.source,
          adId: current.adId,
          key: override.key,
          value: override.value,
          createdAt: override.createdAt.toISOString(),
          ...provenanceOf(override.madeOn, current),
          adCount: offerAds.length,
        },
      ];
    });
  }

  function findByAd(source: Source, adId: string): OfferDetail | undefined {
    const ad = db
      .select()
      .from(offerAds)
      .where(and(eq(offerAds.source, source), eq(offerAds.adId, adId)))
      .get();
    return ad && get(ad.offerId);
  }

  function bumpTime(fetched: FetchedOffer, parsed: ParsedActive): Date | null {
    const seen = db
      .select({ latest: seenAds.onlineLatest })
      .from(seenAds)
      .where(and(eq(seenAds.source, fetched.source), eq(seenAds.adId, fetched.adId)))
      .get();
    if (seen?.latest) return seen.latest;
    return parsed.online?.kind === "relative"
      ? new Date(fetched.fetchedAt - parsed.online.minutes * MINUTE)
      : null;
  }

  type Parsed = FetchedOffer["parsed"];
  type ParsedActive = Extract<Parsed, { status: "active" | "deactivated" }>;

  type PriceSeen = { source: Source; adId: string; observedAt: Date };
  const seenIn = (fetched: FetchedOffer): PriceSeen => ({
    source: fetched.source,
    adId: fetched.adId,
    observedAt: new Date(fetched.fetchedAt),
  });

  function recordPrice(offerId: number, seen: PriceSeen, facts: RuleFacts): void {
    const rent = stated<Money>(facts, "warmRent");
    if (rent === null) return;
    const last = db
      .select()
      .from(offerPrices)
      .where(eq(offerPrices.offerId, offerId))
      .orderBy(desc(offerPrices.observedAt), desc(offerPrices.id))
      .limit(1)
      .get();
    if (last && last.amount === rent.amount && last.converted === rent.converted) return;
    db.insert(offerPrices)
      .values({
        offerId,
        source: seen.source,
        adId: seen.adId,
        observedAt: seen.observedAt,
        amount: rent.amount,
        converted: rent.converted,
      })
      .run();
  }

  /** The Ad ID's row must exist. */
  function recordText(fetched: FetchedOffer, text: OfferText, hash: string): void {
    db.insert(offerTexts)
      .values({
        source: fetched.source,
        adId: fetched.adId,
        contentHash: hash,
        seenAt: new Date(fetched.fetchedAt),
        title: text.title,
        sections: JSON.stringify(text.sections.map(({ label, text }) => ({ label, text }))),
      })
      .onConflictDoNothing()
      .run();
  }

  const markIngested = (source: Source, adId: string, at: Date) =>
    db
      .update(seenAds)
      .set({ ingestedAt: at })
      .where(and(eq(seenAds.source, source), eq(seenAds.adId, adId)))
      .run();

  const adKey = (source: Source, adId: string) =>
    and(eq(offerAds.source, source), eq(offerAds.adId, adId));

  const sameAd = (a: OfferAdRow, b: OfferAdRow) => a.source === b.source && a.adId === b.adId;

  /** Facts always come from the page the Offer links to and the model reads. */
  function followCurrent(offerId: number, before: OfferAdRow): boolean {
    const row = db.select().from(offers).where(eq(offers.id, offerId)).get();
    const ads = adsOf([offerId]).get(offerId) ?? [];
    if (row === undefined || ads.length === 0) return false;
    const current = currentAd(ads);
    if (sameAd(current, before)) return false;
    return takePage(row, current);
  }

  function takePage(row: OfferRow, current: OfferAdRow): boolean {
    const offerId = row.id;
    const page = readPage(current, row);
    if (page === undefined) return false;
    const now = new Date(clock());
    db.update(offers)
      .set({
        category: page.parsed.category,
        title: page.parsed.text.title || page.card.title,
        facts: JSON.stringify(page.parsed.facts),
        card: JSON.stringify(page.card),
        rulesVersion: page.parsed.rulesVersion,
        updatedAt: now,
      })
      .where(eq(offers.id, offerId))
      .run();
    recordPrice(
      offerId,
      { source: current.source, adId: current.adId, observedAt: storedPageTime(current, offerId) },
      page.parsed.facts,
    );
    return true;
  }

  /** Never before the latest price point, so the last point stays the rent the Offer has. */
  function storedPageTime(ad: OfferAdRow, offerId: number): Date {
    const fetchedAt =
      db
        .select({ at: seenAds.detailFetchedAt })
        .from(seenAds)
        .where(and(eq(seenAds.source, ad.source), eq(seenAds.adId, ad.adId)))
        .get()?.at ?? null;
    if (fetchedAt === null) return new Date(clock());
    const latest = db
      .select({ at: offerPrices.observedAt })
      .from(offerPrices)
      .where(eq(offerPrices.offerId, offerId))
      .orderBy(desc(offerPrices.observedAt))
      .limit(1)
      .get()?.at;
    return latest !== undefined && latest > fetchedAt ? latest : fetchedAt;
  }

  const profileOfPage = (card: SearchCard, parsed: ParsedActive): AdProfile =>
    adProfileOf({ category: parsed.category, facts: parsed.facts, card, text: parsed.text });

  /**
   * A page failure is over as soon as the current Ad ID's stored page reads, however that came
   * about. Nothing is read by the model because of it. Any other failure stands: the same words
   * would fail the same way.
   */
  function endPageFailure(offerId: number): void {
    const row = db.select().from(offers).where(eq(offers.id, offerId)).get();
    if (row === undefined) return;
    const { failure, ...kept } = parseStoredAnalysis(row.analysis);
    if (failure === undefined || !isPageFailure(failure.kind)) return;
    const ads = adsOf([offerId]).get(offerId) ?? [];
    if (ads.length === 0 || readPage(currentAd(ads), row) === undefined) return;
    db.update(offers)
      .set({
        analysisState: row.analysisState === "failed" ? "pending" : row.analysisState,
        analysis: Object.keys(kept).length > 0 ? JSON.stringify(kept) : null,
      })
      .where(eq(offers.id, offerId))
      .run();
    // The status changed and no read follows to say so. Inside a caller's transaction it goes out
    // once that has ended, as band moves do.
    if (db.$client.inTransaction) queueMicrotask(() => analysisContext.announce(offerId));
    else analysisContext.announce(offerId);
  }

  function pageChanged(offerId: number): RankedEntry | undefined {
    endPageFailure(offerId);
    return reband(offerId);
  }

  function storePage(fetched: FetchedOffer): IngestResult {
    const { parsed } = fetched;
    const now = new Date(clock());

    if (parsed.status === "deleted") {
      const gone = db.$client.transaction((): IngestResult => {
        const known = db.select().from(offerAds).where(adKey(fetched.source, fetched.adId)).get();
        const before = known && currentAd(adsOf([known.offerId]).get(known.offerId) ?? []);
        // Reading that the page is gone is a Recheck that worked: nothing waits to retry it.
        db.update(offerAds)
          .set({ pageStatus: "deleted", recheckedAt: null })
          .where(adKey(fetched.source, fetched.adId))
          .run();
        if (known !== undefined && before !== undefined) {
          followCurrent(known.offerId, before);
          db.update(offers).set({ updatedAt: now }).where(eq(offers.id, known.offerId)).run();
        }
        markIngested(fetched.source, fetched.adId, now);
        return { outcome: "none", offerId: known?.offerId ?? null, reusedFacts: false };
      })();
      if (gone.offerId !== null) pageChanged(gone.offerId);
      return gone;
    }

    const seen = db
      .select()
      .from(seenAds)
      .where(and(eq(seenAds.source, fetched.source), eq(seenAds.adId, fetched.adId)))
      .get();
    const firstSeenAt = seen?.firstSeenAt ?? new Date(fetched.fetchedAt);
    const lastBumpAt = bumpTime(fetched, parsed);
    const hash = contentHash(parsed.text);
    const profile = profileOfPage(fetched.card, parsed);
    const stored = dedupe.profileColumns(profile);
    const values = {
      category: parsed.category,
      title: parsed.text.title || fetched.card.title,
      facts: JSON.stringify(parsed.facts),
      card: JSON.stringify(fetched.card),
      rulesVersion: parsed.rulesVersion,
      updatedAt: now,
    };

    const result = db.$client.transaction((): IngestResult => {
      const known = db.select().from(offerAds).where(adKey(fetched.source, fetched.adId)).get();
      if (known) {
        const before = currentAd(adsOf([known.offerId]).get(known.offerId) ?? [known]);
        db.update(offerAds)
          .set({
            pageStatus: parsed.status,
            lastBumpAt: lastBumpAt ?? known.lastBumpAt,
            contentHash: hash,
            pageCardKey: cardKey(fetched.card),
            recheckedAt: null,
            ...stored,
          })
          .where(adKey(fetched.source, fetched.adId))
          .run();
        recordText(fetched, parsed.text, hash);
        const ads = adsOf([known.offerId]).get(known.offerId) ?? [];
        const current = currentAd(ads);
        if (current.source === fetched.source && current.adId === fetched.adId) {
          db.update(offers).set(values).where(eq(offers.id, known.offerId)).run();
          recordPrice(known.offerId, seenIn(fetched), parsed.facts);
        } else if (!followCurrent(known.offerId, before)) {
          db.update(offers).set({ updatedAt: now }).where(eq(offers.id, known.offerId)).run();
        }
        markIngested(fetched.source, fetched.adId, now);
        if (known.profile !== stored.profile) dedupe.relink(fetched.source, [fetched.adId]);
        return { outcome: "refreshed", offerId: known.offerId, reusedFacts: false };
      }

      const ad = {
        source: fetched.source,
        adId: fetched.adId,
        path: fetched.card.path,
        firstSeenAt,
        lastBumpAt,
        pageStatus: parsed.status,
        contentHash: hash,
        pageCardKey: cardKey(fetched.card),
        ...stored,
      };

      const twin = dedupe.findDuplicate(fetched.source, fetched.adId, profile);
      const target = twin && db.select().from(offers).where(eq(offers.id, twin.offerId)).get();
      if (target) {
        const reusedFacts = (adsOf([target.id]).get(target.id) ?? []).some(
          (other) => other.contentHash === hash,
        );
        db.insert(offerAds)
          .values({ ...ad, offerId: target.id })
          .run();
        recordText(fetched, parsed.text, hash);
        const isCurrent = currentAd(adsOf([target.id]).get(target.id) ?? []).adId === fetched.adId;
        db.update(offers)
          .set({
            firstSeenAt: new Date(Math.min(firstSeenAt.getTime(), target.firstSeenAt.getTime())),
            ...(isCurrent && values),
          })
          .where(eq(offers.id, target.id))
          .run();
        if (isCurrent) recordPrice(target.id, seenIn(fetched), parsed.facts);
        markIngested(fetched.source, fetched.adId, now);
        dedupe.relink(fetched.source, [fetched.adId]);
        return { outcome: "merged", offerId: target.id, reusedFacts };
      }

      const offer = db
        .insert(offers)
        .values({ ...values, analysisState: "pending", firstSeenAt, createdAt: now })
        .returning({ id: offers.id })
        .get();
      db.insert(offerAds)
        .values({ ...ad, offerId: offer.id })
        .run();
      recordText(fetched, parsed.text, hash);
      recordPrice(offer.id, seenIn(fetched), parsed.facts);
      markIngested(fetched.source, fetched.adId, now);
      dedupe.relink(fetched.source, [fetched.adId]);
      return { outcome: "created", offerId: offer.id, reusedFacts: false };
    })();

    // A page can show the Offer again. Were the clocks left to the nightly prune, an Offer quiet
    // again before it would keep the clock of its earlier quiet spell. A new one has none.
    if (result.outcome !== "created" && result.offerId !== null) {
      refreshOfferClocks(db, result.offerId, clock());
    }
    const entry = result.offerId === null ? undefined : pageChanged(result.offerId);
    if (result.outcome === "created" && entry !== undefined) {
      events?.publish("offer-added", summaryOf(entry));
    }
    return result;
  }

  const ingestListeners: ((result: IngestResult) => void)[] = [];

  function ingest(fetched: FetchedOffer): IngestResult {
    const result = storePage(fetched);
    for (const listener of ingestListeners) listener(result);
    return result;
  }

  type Sighting = {
    source: Source;
    adId: string;
    card: SearchCard;
    bumped: boolean;
    /** The newest instant the card's age allows; null when it showed none. */
    lastBumpAt: number | null;
  };

  /** `returning`: a Stale Ad ID came back on a card or was Bumped within 7 days: Recheck it. */
  function noteSighting(sighting: Sighting): { returning: boolean } {
    const { source, adId, card, bumped, lastBumpAt } = sighting;
    const touched: number[] = [];
    const result = db.$client.transaction(() => {
      const known = db.select().from(offerAds).where(adKey(source, adId)).get();
      if (known === undefined) return { returning: false };
      touched.push(known.offerId);
      const now = clock();
      const recent = lastBumpAt !== null && lastBumpAt >= now - STALE_AFTER_DAYS * DAY;
      const returning = isAdStale(known, now) && (known.pageStatus !== "active" || recent);
      if (bumped && lastBumpAt !== null) {
        const before = currentAd(adsOf([known.offerId]).get(known.offerId) ?? [known]);
        db.update(offerAds)
          .set({ lastBumpAt: new Date(lastBumpAt) })
          .where(adKey(source, adId))
          .run();
        followCurrent(known.offerId, before);
      }
      const current = currentAd(adsOf([known.offerId]).get(known.offerId) ?? []);
      if (current.source !== source || current.adId !== adId) return { returning };
      const offer = db.select().from(offers).where(eq(offers.id, known.offerId)).get();
      const json = JSON.stringify(card);
      if (offer !== undefined && offer.card !== json) {
        db.update(offers)
          .set({ card: json, updatedAt: new Date(clock()) })
          .where(eq(offers.id, known.offerId))
          .run();
      }
      return { returning };
    })();
    // A Bump makes an Offer recent again, which can lift it out of Stale, and can move it to
    // another Ad ID's page.
    for (const id of touched) {
      // So can the card's Search match, written just before in the same transaction: either can
      // show the Offer again. See `storePage`.
      refreshOfferClocks(db, id, clock());
      pageChanged(id);
    }
    return result;
  }

  /** Until the analysis worker attaches, nothing is in flight and the cap is open. */
  let analysisContext: AnalysisContext = {
    reading: () => false,
    unstored: () => false,
    cap: () => ({ state: "ok", resetsAt: null }),
    noRoom: () => new Set(),
    announce: () => {},
  };

  function analysisSnapshot(): AnalysisSnapshot {
    const held = new Map<number, { stage: 1 | 2; since: Date }>();
    const waiting = db
      .select({
        offerId: analysisItems.offerId,
        stage: analysisItems.stage,
        createdAt: analysisItems.createdAt,
      })
      .from(analysisItems)
      .where(inArray(analysisItems.state, WAITING))
      .all();
    for (const item of waiting) {
      const before = held.get(item.offerId);
      // An escalation pass says more than a first pass, should both ever be held.
      if (before === undefined || item.stage > before.stage) {
        held.set(item.offerId, { stage: item.stage === 2 ? 2 : 1, since: item.createdAt });
      }
    }
    const settings = loadAnalysisSettings(db);
    return {
      held,
      key: keyState(db),
      cap: analysisContext.cap(),
      noRoom: analysisContext.noRoom(),
      version: analysisVersion({ model: settings.model, effort: settings.effort }),
      now: clock(),
    };
  }

  function statusOf(row: OfferRow, ads: OfferAdRow[], at: AnalysisSnapshot): AnalysisStatus {
    const job = jobOf(row, ads);
    if (job === undefined) throw new Error("an Offer always has an Ad ID");
    return deriveAnalysisStatus({
      state: job.state,
      stale: job.stale,
      wordsChanged: job.wordsChanged,
      olderVersion: onOlderAnalysis(job, at.version),
      provisional: job.state === "analyzed" && job.escalation !== null,
      escalationResends: job.escalation?.resends ?? 0,
      failure: job.failure,
      contentHash: job.contentHash,
      held: at.held.get(row.id) ?? null,
      reading: analysisContext.reading(row.id),
      unstored: analysisContext.unstored(row.id),
      owed: job.reanalyzeRequestedAt !== null,
      noRoom: at.noRoom.has(row.id),
      key: at.key,
      cap: at.cap,
      now: at.now,
    });
  }

  function failureOf(row: OfferRow): AnalysisJob["failure"] {
    const failure = parseStoredAnalysis(row.analysis).failure;
    if (failure === undefined) return null;
    return {
      kind: failure.kind,
      at: Date.parse(failure.at),
      attempts: failure.attempts ?? 1,
      contentHash: failure.contentHash ?? null,
    };
  }

  function jobOf(row: OfferRow, ads: OfferAdRow[]): AnalysisJob | undefined {
    if (ads.length === 0) return undefined;
    const current = currentAd(ads);
    const stored = parseStoredAnalysis(row.analysis);
    const run = stored.run;
    return {
      id: row.id,
      category: row.category,
      source: current.source,
      adId: current.adId,
      adFirstSeenAt: current.firstSeenAt,
      adCategory: current.category,
      state: row.analysisState,
      stale: isOfferStale(ads, clock()),
      wordsChanged:
        row.analysisState === "analyzed" &&
        current.contentHash !== null &&
        run?.contentHash !== current.contentHash,
      contentHash: current.contentHash,
      readDepth: readDepth(row, current.contentHash),
      lastBumpAt: current.lastBumpAt?.getTime() ?? null,
      analysisVersion: run?.analysisVersion ?? null,
      failure: failureOf(row),
      ranWith: run ? { model: run.model, effort: run.effort } : null,
      escalation: stored.escalation ?? null,
      reanalyzeRequestedAt: row.reanalyzeRequestedAt?.getTime() ?? null,
    };
  }

  function analysisJobs(): AnalysisJob[] {
    const rows = db.select().from(offers).all();
    const ads = adsOf(rows.map((row) => row.id));
    return rows.flatMap((row) => jobOf(row, ads.get(row.id) ?? []) ?? []);
  }

  function analysisJob(id: number): AnalysisJob | undefined {
    const row = db.select().from(offers).where(eq(offers.id, id)).get();
    return row && jobOf(row, adsOf([id]).get(id) ?? []);
  }

  function requestReanalysis(id: number): void {
    db.update(offers)
      .set({ reanalyzeRequestedAt: new Date(clock()) })
      .where(and(eq(offers.id, id), isNull(offers.reanalyzeRequestedAt)))
      .run();
  }

  function owedReanalyses(): number[] {
    return db
      .select({ id: offers.id })
      .from(offers)
      .where(isNotNull(offers.reanalyzeRequestedAt))
      .orderBy(asc(offers.reanalyzeRequestedAt), asc(offers.id))
      .all()
      .map((row) => row.id);
  }

  /** Callers run it in the transaction that queues that request. */
  function handOverReanalysis(id: number): void {
    db.update(offers).set({ reanalyzeRequestedAt: null }).where(eq(offers.id, id)).run();
  }

  function saveAnalysis(
    id: number,
    facts: ModelFacts,
    run: AnalysisRun,
    escalation?: OwedEscalation,
  ): void {
    db.update(offers)
      .set({
        analysisState: "analyzed",
        modelFacts: JSON.stringify(facts),
        analysis: JSON.stringify({ run, ...(escalation && { escalation }) }),
        reanalyzeRequestedAt: null,
        updatedAt: new Date(clock()),
      })
      .where(eq(offers.id, id))
      .run();
    reband(id);
  }

  /** Counted, so a lost escalation pass that keeps failing stops being resent. */
  function noteEscalationResent(id: number): void {
    const row = db.select().from(offers).where(eq(offers.id, id)).get();
    if (row === undefined) return;
    const stored = parseStoredAnalysis(row.analysis);
    if (stored.escalation === undefined) return;
    const escalation = {
      ...stored.escalation,
      resends: (stored.escalation.resends ?? 0) + 1,
      resentAt: clock(),
    };
    db.update(offers)
      .set({ analysis: JSON.stringify({ ...stored, escalation }) })
      .where(eq(offers.id, id))
      .run();
  }

  function failAnalysis(id: number, kind: string): void {
    const row = db.select().from(offers).where(eq(offers.id, id)).get();
    if (row === undefined) return;
    const ads = adsOf([id]).get(id) ?? [];
    const hash = ads.length > 0 ? currentAd(ads).contentHash : null;
    const before = parseStoredAnalysis(row.analysis).failure;
    // Attempts in a row on the same words; other words, or a success in between, start over. A
    // kind that doesn't count as an attempt (a refused key, a missing page) leaves the count be.
    const sameWords = before !== undefined && (before.contentHash ?? hash) === hash;
    const counted = sameWords ? (before.attempts ?? 1) : 0;
    const failure: AnalysisFailure = {
      kind,
      at: new Date(clock()).toISOString(),
      attempts: counted + (policyOf(kind).countsAsAttempt ? 1 : 0),
      contentHash: hash,
    };
    db.update(offers)
      .set({
        analysisState: row.analysisState === "analyzed" ? "analyzed" : "failed",
        analysis: JSON.stringify({ ...parseStoredAnalysis(row.analysis), failure }),
        reanalyzeRequestedAt: null,
        updatedAt: new Date(clock()),
      })
      .where(eq(offers.id, id))
      .run();
  }

  /** The Offer's words changed: what was read from the old ones is no longer its facts. */
  function resetAnalysis(id: number): void {
    db.update(offers)
      .set({ analysisState: "pending", modelFacts: null, analysis: null })
      .where(eq(offers.id, id))
      .run();
    reband(id);
  }

  /** `awaiting`: Offers that will be read without anyone acting. */
  function analysisCounts(): {
    pending: number;
    analyzed: number;
    failed: number;
    awaiting: number;
    byStatus: Record<AnalysisStatusKind, number>;
  } {
    const counts = { pending: 0, analyzed: 0, failed: 0, awaiting: 0 };
    const rows = db.select().from(offers).all();
    const ads = adsOf(rows.map((row) => row.id));
    const now = analysisSnapshot();
    const statuses: AnalysisStatus[] = [];
    for (const row of rows) {
      const own = ads.get(row.id) ?? [];
      if (own.length === 0) continue;
      counts[row.analysisState]++;
      const status = statusOf(row, own, now);
      if (status.willRead) counts.awaiting++;
      statuses.push(status);
    }
    return { ...counts, byStatus: countByStatus(statuses) };
  }

  function analysisStatus(id: number): AnalysisStatus | undefined {
    const row = db.select().from(offers).where(eq(offers.id, id)).get();
    const ads = row && adsOf([id]).get(id);
    if (row === undefined || ads === undefined || ads.length === 0) return undefined;
    return statusOf(row, ads, analysisSnapshot());
  }

  /** For Offers stored by a build that ranked Ad IDs differently. */
  async function followStoredCurrent(): Promise<CatchUpStep> {
    const ids = db.select({ id: offers.id }).from(offers).all();
    return eachItem(
      ids,
      {
        stopped: () => stopped,
        describe: ({ id }) => `following the current Ad ID of Offer ${id}`,
      },
      ({ id }) => {
        const row = db.select().from(offers).where(eq(offers.id, id)).get();
        const ads = adsOf([id]).get(id);
        if (row === undefined || ads === undefined || ads.length === 0) return "none";
        const current = currentAd(ads);
        const onPage = (JSON.parse(row.card) as Partial<SearchCard>).adId;
        if (onPage === current.adId) return "none";
        if (!takePage(row, current)) return "skipped";
        pageChanged(id);
        return "done";
      },
    );
  }

  function reparseOffer(
    listedId: number,
    reprofiled: (ad: OfferAdRow) => void = () => {},
  ): "done" | "skipped" | "none" {
    // An Offer merged away while this waited lives on in its survivor, which may have taken its
    // older facts; the survivor is read instead.
    const id = mergedInto(listedId) ?? listedId;
    const row = db.select().from(offers).where(eq(offers.id, id)).get();
    const ads = adsOf([id]).get(id);
    if (row === undefined || ads === undefined || ads.length === 0) return "none";
    const current = currentAd(ads);
    if (row.rulesVersion >= adapters[current.source].rulesVersion) return "none";
    let reparsedCurrent = false;
    for (const ad of ads) {
      const page = readPage(ad, row);
      if (page === undefined) continue;
      const { parsed, card } = page;
      const hash = contentHash(parsed.text);
      db.$client.transaction(() => {
        db.update(offerAds)
          .set({ contentHash: hash, ...dedupe.profileColumns(profileOfPage(card, parsed)) })
          .where(adKey(ad.source, ad.adId))
          .run();
        // New rules read the same stored page: a correction made on it was made on these words.
        if (ad.contentHash !== null && ad.contentHash !== hash) {
          factOverrides.rehash(ad, ad.contentHash, hash);
        }
      })();
      reprofiled(ad);
      if (ad.source !== current.source || ad.adId !== current.adId) continue;
      db.update(offers)
        .set({
          title: parsed.text.title || row.title,
          facts: JSON.stringify(parsed.facts),
          rulesVersion: parsed.rulesVersion,
          updatedAt: new Date(clock()),
        })
        .where(eq(offers.id, id))
        .run();
      reparsedCurrent = true;
    }
    if (!reparsedCurrent) return "skipped";
    pageChanged(id);
    return "done";
  }

  function reparseOutdated(): Promise<CatchUpStep> {
    reparsing ??= (async () => {
      let reprofiled = 0;
      const newest = Math.max(...Object.values(adapters).map((adapter) => adapter.rulesVersion));
      const outdated = db
        .select({ id: offers.id })
        .from(offers)
        .where(lt(offers.rulesVersion, newest))
        .all();
      const step = await eachItem(
        outdated,
        { stopped: () => stopped, describe: ({ id }) => `re-parsing Offer ${id}` },
        ({ id }) =>
          reparseOffer(id, () => {
            reprofiled++;
          }),
      );
      // New rules may read the Advertiser or the flat differently, so Duplicates may have appeared.
      // After a break-off the pass would only meet the same database; the next start makes it.
      if (reprofiled > 0 && step.state !== "failed") dedupePass();
      return step;
    })().finally(() => {
      reparsing = undefined;
    });
    return reparsing;
  }

  /**
   * For a page about to replace the stored one: a correction made on an old reading can follow it
   * to the newest rules only while the page it was made on is still there.
   */
  function reparseIfOutdated(ad: { source: Source; adId: string }): void {
    const known = db
      .select({ offerId: offerAds.offerId })
      .from(offerAds)
      .where(adKey(ad.source, ad.adId))
      .get();
    if (known === undefined) return;
    const reprofiled: OfferAdRow[] = [];
    try {
      reparseOffer(known.offerId, (ad) => reprofiled.push(ad));
    } finally {
      // The page that follows reads the profile just stored, so storePage will not relink it, and
      // no dedupe pass comes after this one Offer.
      for (const source of new Set(reprofiled.map((ad) => ad.source))) {
        const adIds = reprofiled.filter((ad) => ad.source === source).map((ad) => ad.adId);
        dedupe.relink(source, adIds);
      }
    }
  }

  function cardOf(ad: OfferAdRow, fallback: string): SearchCard {
    const seen = db
      .select({ card: seenAds.card })
      .from(seenAds)
      .where(and(eq(seenAds.source, ad.source), eq(seenAds.adId, ad.adId)))
      .get();
    return JSON.parse(seen?.card ?? fallback) as SearchCard;
  }

  /** Undefined when the page was deleted, is gone from the data folder, or no longer parses. */
  function readPage(ad: OfferAdRow, offer: OfferRow) {
    if (ad.pageStatus === "deleted") return undefined;
    const page = readStoredPage({ adapters, snapshots }, ad, offer.category);
    if (page.state !== "readable") return undefined;
    return { parsed: page.parsed, card: cardOf(ad, offer.card) };
  }

  /**
   * One whose page is gone or unreadable keeps what it has: none skips dedupe, an older one ignores
   * photos.
   */
  async function backfillProfiles(): Promise<CatchUpStep> {
    const missing = db
      .select()
      .from(offerAds)
      .where(and(profileOutdated(), ne(offerAds.pageStatus, "deleted")))
      .all();
    return eachItem(
      missing,
      {
        stopped: () => stopped,
        describe: ({ adId }) => `filling in the dedupe profile of Ad ID ${adId}`,
      },
      (listed) => {
        // Read afresh: a merge while this waited may have moved the Ad ID to another Offer.
        const ad = db.select().from(offerAds).where(adKey(listed.source, listed.adId)).get();
        if (ad === undefined) return "none";
        const offer = db.select().from(offers).where(eq(offers.id, ad.offerId)).get();
        const page = offer && readPage(ad, offer);
        if (!page) return "skipped";
        db.update(offerAds)
          .set({
            ...dedupe.profileColumns(profileOfPage(page.card, page.parsed)),
            contentHash: ad.contentHash ?? contentHash(page.parsed.text),
          })
          .where(adKey(ad.source, ad.adId))
          .run();
        return "done";
      },
    );
  }

  /** Callers run it in a transaction, then call `afterMerges`. */
  function mergeInto(survivorId: number, absorbedId: number): void {
    const survivor = db.select().from(offers).where(eq(offers.id, survivorId)).get();
    const absorbed = db.select().from(offers).where(eq(offers.id, absorbedId)).get();
    if (survivor === undefined || absorbed === undefined) return;
    const absorbedAds = adsOf([absorbedId]).get(absorbedId) ?? [];
    const current = currentAd([...(adsOf([survivorId]).get(survivorId) ?? []), ...absorbedAds]);
    const takesOver = absorbedAds.some(
      (ad) => ad.source === current.source && ad.adId === current.adId,
    );
    const now = new Date(clock());
    // Read before the Ad IDs move: which side's verdicts still pin it decides the merged release.
    const pairPinned = {
      survivor: isPairPinned(db, survivorId),
      absorbed: isPairPinned(db, absorbedId),
    };
    db.update(offerAds).set({ offerId: survivorId }).where(eq(offerAds.offerId, absorbedId)).run();
    db.update(offerPrices)
      .set({ offerId: survivorId })
      .where(eq(offerPrices.offerId, absorbedId))
      .run();
    factOverrides.moveTo(survivorId, absorbedId);
    const { id: _, ...merged } = mergedRow(survivor, absorbed, {
      takesOver,
      currentHash: current.contentHash,
      pairPinned,
      now,
    });
    db.update(offers).set(merged).where(eq(offers.id, survivorId)).run();
    // Tombstones of Offers the absorbed one took in move on first: removing it would take them.
    db.update(offerTombstones)
      .set({ mergedInto: survivorId })
      .where(eq(offerTombstones.mergedInto, absorbedId))
      .run();
    db.insert(offerTombstones)
      .values({ offerId: absorbedId, mergedInto: survivorId })
      .onConflictDoUpdate({
        target: offerTombstones.offerId,
        set: { mergedInto: survivorId },
      })
      .run();
    // A request is the next step from what its Offer had read: a first read, the escalation of a
    // first pass, or another read after a click or in a run. Answered on an Offer that has read
    // further, it would overwrite the newer result or ask for a second escalation. Not so where
    // the merged Offer owes a click: the answer to any waiting request ends it, so withdrawing one
    // means a second paid read, unless a read that is out answers the click itself.
    const reached = readDepth(merged, current.contentHash);
    const forClick =
      merged.reanalyzeRequestedAt !== null &&
      !analysisContext.reading(survivorId) &&
      !analysisContext.reading(absorbedId);
    const keeps = (side: OfferRow) => forClick || reached <= readDepth(side, current.contentHash);
    carryWaiting(db, absorbedId, survivorId, current.contentHash, {
      survivor: keeps(survivor),
      absorbed: keeps(absorbed),
    });
    db.delete(offers).where(eq(offers.id, absorbedId)).run();
  }

  /** Runs after the merges commit. */
  function afterMerges(merges: { offerId: number; mergedInto: number }[]): void {
    for (const merge of merges) events?.publish("offer-merged", merge);
    // The survivor may have taken a reading with a page failure onto an Ad ID whose page reads.
    for (const id of new Set(merges.map((merge) => merge.mergedInto))) pageChanged(id);
  }

  function mergedInto(id: number): number | undefined {
    return db
      .select({ mergedInto: offerTombstones.mergedInto })
      .from(offerTombstones)
      .where(eq(offerTombstones.offerId, id))
      .get()?.mergedInto;
  }

  /** Duplicates (and "same room" verdicts) collapse into the oldest; verdicts are never undone. */
  function dedupePass(): number {
    const merges = db.$client.transaction(() => {
      const lookup = dedupe.overrideLookup();
      const photos = dedupe.photoIndexes();
      const rows = db.select().from(offerAds).all();
      const groups = new Map<number, OfferAdRow[]>();
      for (const row of rows) groups.set(row.offerId, [...(groups.get(row.offerId) ?? []), row]);
      const rootOf = new Map([...groups.keys()].map((id) => [id, id]));
      const find = (id: number): number => {
        let root = id;
        for (let next = rootOf.get(root); next !== root && next !== undefined; ) {
          root = next;
          next = rootOf.get(root);
        }
        return root;
      };

      const edges: { a: OfferAdRow; b: OfferAdRow; sharedImages: number; text: number }[] = [];
      for (const bucket of dedupe.buckets(rows)) {
        bucket.forEach((mine, index) => {
          for (const other of bucket.slice(index + 1)) {
            if (mine.row.offerId === other.row.offerId) continue;
            const comparison = dedupe.relate(
              mine.row.source,
              mine,
              other,
              lookup,
              photos(mine.row.source),
            );
            if (comparison.relation === "duplicate") {
              edges.push({
                a: mine.row,
                b: other.row,
                sharedImages: comparison.sharedImages,
                text: comparison.textSimilarity ?? 0,
              });
            }
          }
        });
      }
      edges.sort((x, y) => y.sharedImages - x.sharedImages || y.text - x.text);

      for (const { a, b } of edges) {
        const [rootA, rootB] = [find(a.offerId), find(b.offerId)];
        if (rootA === rootB) continue;
        if (!dedupe.mayJoin(groups.get(rootA) ?? [], groups.get(rootB) ?? [], lookup)) continue;
        const [keep, drop] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
        rootOf.set(drop, keep);
        groups.set(keep, [...(groups.get(keep) ?? []), ...(groups.get(drop) ?? [])]);
        groups.delete(drop);
      }

      const merged: { offerId: number; mergedInto: number }[] = [];
      for (const id of [...rootOf.keys()].sort((x, y) => x - y)) {
        const root = find(id);
        if (root === id) continue;
        mergeInto(root, id);
        merged.push({ offerId: id, mergedInto: root });
      }
      dedupe.rebuildLinks();
      return merged;
    })();
    afterMerges(merges);
    return merges.length;
  }

  const relinkAll = (ads: OfferAdRow[]) => {
    for (const source of new Set(ads.map((ad) => ad.source))) {
      dedupe.relink(
        source,
        ads.filter((ad) => ad.source === source).map((ad) => ad.adId),
      );
    }
  };

  /** A `not-found` says which of the two ids has no Offer: `id` when neither has one. */
  function mergeOffers(
    id: number,
    otherId: number,
  ):
    | { ok: true; offer: OfferDetail }
    | { ok: false; problem: "same-offer" }
    | { ok: false; problem: "not-found"; missing: number } {
    if (id === otherId) return { ok: false, problem: "same-offer" };
    const missing = db.$client.transaction(() => {
      const [keep, drop] = [
        db.select().from(offers).where(eq(offers.id, id)).get(),
        db.select().from(offers).where(eq(offers.id, otherId)).get(),
      ];
      if (keep === undefined) return id;
      if (drop === undefined) return otherId;
      const ads = adsOf([id, otherId]);
      dedupe.recordSame(ads.get(id) ?? [], ads.get(otherId) ?? []);
      mergeInto(id, otherId);
      relinkAll([...(ads.get(id) ?? []), ...(ads.get(otherId) ?? [])]);
      return undefined;
    })();
    if (missing !== undefined) return { ok: false, problem: "not-found", missing };
    afterMerges([{ offerId: otherId, mergedInto: id }]);
    const offer = rebanded(id);
    return offer ? { ok: true, offer } : { ok: false, problem: "not-found", missing: id };
  }

  function splitOffer(
    id: number,
    source: Source,
    adId: string,
  ):
    | { ok: true; offer: OfferDetail }
    | { ok: false; problem: "not-found" | "ad-not-in-offer" | "only-ad" } {
    const created = db.$client.transaction(() => {
      const row = db.select().from(offers).where(eq(offers.id, id)).get();
      if (row === undefined) return "not-found" as const;
      const ads = adsOf([id]).get(id) ?? [];
      const leaving = ads.find((ad) => ad.source === source && ad.adId === adId);
      if (leaving === undefined) return "ad-not-in-offer" as const;
      const staying = ads.filter((ad) => ad !== leaving);
      if (staying.length === 0) return "only-ad" as const;

      const wasCurrent = currentAd(ads) === leaving;
      const own = readPage(leaving, row);
      const now = new Date(clock());
      // Marks and the band go with it: see `CARRY_OVER`.
      const made = db
        .insert(offers)
        .values(
          splitRow(row, {
            page: own && {
              category: own.parsed.category,
              title: own.parsed.text.title || own.card.title,
              facts: JSON.stringify(own.parsed.facts),
              card: JSON.stringify(own.card),
              rulesVersion: own.parsed.rulesVersion,
            },
            leavingHash: leaving.contentHash,
            leavingFirstSeenAt: leaving.firstSeenAt,
            now,
          }),
        )
        .returning({ id: offers.id })
        .get();
      db.update(offerAds).set({ offerId: made.id }).where(adKey(source, adId)).run();
      db.update(offerPrices)
        .set({ offerId: made.id })
        .where(and(eq(offerPrices.source, source), eq(offerPrices.adId, adId)))
        .run();
      // Left behind, a request for the leaving words would hold an Offer that no longer shows them
      // while the new one sends them again.
      if (leaving.contentHash !== null && currentAd(staying).contentHash !== leaving.contentHash) {
        db.update(analysisItems)
          .set({ offerId: made.id })
          .where(
            and(
              eq(analysisItems.offerId, id),
              inArray(analysisItems.state, WAITING),
              eq(analysisItems.contentHash, leaving.contentHash),
            ),
          )
          .run();
      }

      // An Ad ID that never changed the rent has no price point of its own; the Offer it left
      // holds the point it shared, so the new Offer starts its history from this page.
      const rent = own && stated<Money>(own.parsed.facts, "warmRent");
      const hasPoint =
        db.select().from(offerPrices).where(eq(offerPrices.offerId, made.id)).get() !== undefined;
      if (rent && !hasPoint) {
        db.insert(offerPrices)
          .values({
            offerId: made.id,
            source,
            adId,
            observedAt: leaving.firstSeenAt,
            amount: rent.amount,
            converted: rent.converted,
          })
          .run();
      }

      const next = wasCurrent ? readPage(currentAd(staying), row) : undefined;
      db.update(offers)
        .set({
          firstSeenAt: new Date(Math.min(...staying.map((ad) => ad.firstSeenAt.getTime()))),
          updatedAt: now,
          ...(next && {
            category: next.parsed.category,
            title: next.parsed.text.title || next.card.title,
            facts: JSON.stringify(next.parsed.facts),
            card: JSON.stringify(next.card),
            rulesVersion: next.parsed.rulesVersion,
          }),
        })
        .where(eq(offers.id, id))
        .run();

      dedupe.recordDifferent([leaving], staying);
      relinkAll(ads);
      return made.id;
    })();
    if (typeof created !== "number") return { ok: false, problem: created };
    // The new Offer copied the room's clocks; the split's verdicts pin both, so the record clocks
    // stop, and either may have stopped being quiet with the Ad IDs it lost or took.
    for (const each of [id, created]) refreshOfferClocks(db, each, clock());
    // Both rooms are ranked again: the one left behind may have lost its only fresh Ad ID, or the
    // Ad ID whose page was gone.
    pageChanged(id);
    const entry = pageChanged(created);
    if (entry === undefined) return { ok: false, problem: "not-found" };
    events?.publish("offer-added", summaryOf(entry));
    return { ok: true, offer: detailOf(entry) };
  }

  /**
   * An Offer's Ad ID stays fetched (a Recheck reads it again); any other counts as a failed fetch,
   * which a later Bump retries.
   */
  function settleUnadoptable(seen: typeof seenAds.$inferSelect): void {
    const owned = db.select().from(offerAds).where(adKey(seen.source, seen.adId)).get();
    db.update(seenAds)
      .set(owned === undefined ? { detailState: "failed" } : { ingestedAt: new Date(clock()) })
      .where(and(eq(seenAds.source, seen.source), eq(seenAds.adId, seen.adId)))
      .run();
  }

  async function adoptStoredPages(): Promise<CatchUpStep> {
    const waiting = () =>
      db
        .select({ seen: seenAds })
        .from(seenAds)
        .where(and(eq(seenAds.detailState, "fetched"), isNull(seenAds.ingestedAt)))
        .orderBy(seenAds.firstSeenAt)
        .all();
    const keyOf = (seen: typeof seenAds.$inferSelect) => `${seen.source}/${seen.adId}`;
    const orphans = waiting();
    const known = readAdoptFailures(db);
    const failingSince: AdoptFailures = { ...known };
    const step = await eachItem(
      orphans,
      {
        stopped: () => stopped,
        describe: ({ seen }) => `adopting the stored page of Ad ID ${seen.adId}`,
      },
      ({ seen }) => {
        const key = keyOf(seen);
        try {
          const page = readStoredPage({ adapters, snapshots }, seen);
          if (page.state === "missing" || page.state === "unreadable") {
            settleUnadoptable(seen);
            return "skipped";
          }
          const { parsed } = page;
          ingest({
            source: seen.source,
            adId: seen.adId,
            fetchedAt: (seen.detailFetchedAt ?? seen.lastSeenAt).getTime(),
            card: JSON.parse(seen.card) as SearchCard,
            parsed,
          });
          return "done";
        } catch (err) {
          // The database's trouble says nothing about this page.
          if (isDatabaseWide(err)) throw err;
          const since = failingSince[key] ?? clock();
          if (clock() - since < ADOPT_RETRY_DAYS * DAY) {
            failingSince[key] = since;
            throw err;
          }
          settleUnadoptable(seen);
          console.error(
            `Catch-up: gave up on the stored page of Ad ID ${seen.adId}, which has thrown since ${new Date(since).toISOString()}: ${errorKind(err)}`,
          );
          return "skipped";
        }
      },
    );
    // A phase that was stopped or broke off leaves the memory as it was: the database may be
    // closed by now, or not taking writes.
    if (step.state === "finished") {
      // Every page is forgotten when all Offer data was deleted meanwhile.
      const still = new Set(waiting().map(({ seen }) => keyOf(seen)));
      const remembered = Object.fromEntries(
        Object.entries(failingSince).filter(([key]) => still.has(key)),
      );
      if (JSON.stringify(remembered) !== JSON.stringify(known)) {
        saveAdoptFailures(db, remembered, clock());
      }
    }
    return step;
  }

  return {
    list,
    get,
    setMarks,
    setFactOverride,
    clearFactOverride,
    listFactOverrides,
    counts,
    preview,
    rebandAll,
    tick,
    start(): void {
      if (rebandTimer !== undefined) return;
      const run = () => {
        try {
          tick();
        } catch (err) {
          console.error(`Re-banding Offers failed: ${err instanceof Error ? err.name : "error"}`);
        }
      };
      rebandTimer = setInterval(run, REBAND_CHECK_MS);
      rebandTimer.unref();
      run();
    },
    findByAd,
    ingest,
    noteSighting,
    adoptStoredPages,
    followStoredCurrent,
    reparseOutdated,
    reparseIfOutdated,
    onIngested(listener: (result: IngestResult) => void): void {
      ingestListeners.push(listener);
    },
    analysisJobs,
    analysisJob,
    requestReanalysis,
    owedReanalyses,
    handOverReanalysis,
    saveAnalysis,
    failAnalysis,
    noteEscalationResent,
    resetAnalysis,
    analysisCounts,
    analysisStatus,
    attachAnalysis(context: AnalysisContext): void {
      analysisContext = context;
    },
    backfillProfiles,
    dedupePass,
    mergeOffers,
    splitOffer,
    mergedInto,
    releasePairPins,
    /** Call before the database closes. */
    stop(): void {
      stopped = true;
      if (rebandTimer !== undefined) clearInterval(rebandTimer);
      rebandTimer = undefined;
    },
  };
}

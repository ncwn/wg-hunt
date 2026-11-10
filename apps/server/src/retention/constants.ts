/** Constants, not settings: the API shows them read-only. */

/** After the Offer went quiet. */
export const RECORD_DAYS = 90;
/** After its Offer went quiet. */
export const SNAPSHOT_DAYS = 30;
export const UNEXPECTED_PAGE_DAYS = 30;
export const REQUEST_LOG_DAYS = 30;

export const LOW_DISK_BYTES = 1024 ** 3;

/** Berlin time. */
export const PRUNE_AT = { hour: 3, minute: 0 } as const;

export const PRUNE_RETRY = { firstMinutes: 15, maxMinutes: 24 * 60 } as const;

export const RETENTION_CONSTANTS = {
  recordDays: RECORD_DAYS,
  snapshotDays: SNAPSHOT_DAYS,
  unexpectedPageDays: UNEXPECTED_PAGE_DAYS,
  requestLogDays: REQUEST_LOG_DAYS,
  lowDiskBytes: LOW_DISK_BYTES,
  pruneAt: "03:00 Europe/Berlin",
} as const;

export const WIPE_CONFIRMATION = "delete all Offer data";

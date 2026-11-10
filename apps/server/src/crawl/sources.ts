import type { Source, SourceAdapter } from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";

export const SOURCE_ADAPTERS: Record<Source, SourceAdapter> = {
  "wg-gesucht": wgGesuchtSource,
};

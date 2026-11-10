import { registerAnalysis } from "./analysis.js";
import { registerAnalysisSettings } from "./analysis-settings.js";
import type { ApiModule } from "./context.js";
import { registerCrawl } from "./crawl.js";
import { registerEvents } from "./events.js";
import { registerForecast } from "./forecast.js";
import { registerOffers } from "./offers.js";
import { registerSearches } from "./searches.js";
import { registerSecrets } from "./secrets.js";
import { registerSeeking } from "./seeking.js";
import { registerSession } from "./session.js";
import { registerStorage } from "./storage.js";
import { registerSystem } from "./system.js";

export const apiModules: ApiModule[] = [
  registerSystem,
  registerSession,
  registerCrawl,
  registerForecast,
  registerEvents,
  registerSearches,
  registerOffers,
  registerSeeking,
  registerSecrets,
  registerAnalysisSettings,
  registerAnalysis,
  registerStorage,
];

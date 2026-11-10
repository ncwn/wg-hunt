import { useState } from "react";
import type { ApiClient } from "../api/client.js";
import { ForecastTile, NextJobsTile, TodayTile } from "../components/CrawlTiles.js";
import { PacingEditor } from "../components/PacingEditor.js";
import { RequestLog } from "../components/RequestLog.js";
import type { CrawlStatus, EventStream } from "../events.js";
import { useHunt } from "../hunt-status.js";
import { Notice } from "../ui/status.js";
import { Section } from "./Section.js";

function LayoutChangeNotice({ paused }: { paused: NonNullable<CrawlStatus["paused"]> }) {
  const at = paused.path ? ` at ${paused.path}` : "";
  const kept = paused.savedAs && ` The page is kept in the data folder as ${paused.savedAs}.`;
  if (paused.cause === "handler-error") {
    return (
      <Notice tone="alarm" title="wg-hunt stopped: it couldn't finish handling a page">
        wg-hunt failed while handling the page{at}. Switching Keep hunting back on tries again. If
        wg-hunt stops again, the cause can be the disk, the database, or a page wg-hunt can't
        handle: the server's log has the error, and the newest "Handling failed" row of the request
        log below names the page.
        {kept}
      </Notice>
    );
  }
  return (
    <Notice tone="alarm" title="wg-hunt stopped: a page looked different">
      wg-gesucht showed a page wg-hunt doesn't understand{at}, and it didn't look like a check for a
      person. wg-hunt waits until you switch Keep hunting back on.
      {kept}
    </Notice>
  );
}

export function AdvancedCrawl({
  api,
  events,
  refresh,
  onSaved,
}: {
  api: ApiClient;
  events: EventStream;
  refresh: number;
  onSaved: () => void;
}) {
  const { view } = useHunt();
  const [saved, setSaved] = useState(0);
  const paused = view.status === "ready" ? view.crawl.paused : null;
  // The half budget after a Cooldown halves the cap every forecast is worked from, so its start
  // and end (each published as a status) mean reading the forecasts again, drafts included.
  const halfBudget = view.status === "ready" ? (view.crawl.halfBudgetUntil ?? "") : "";

  return (
    <Section title="Checking wg-gesucht">
      {paused?.reason === "layout-changed" && <LayoutChangeNotice paused={paused} />}

      {paused?.reason === "disk-full" && (
        <Notice tone="alarm" title="wg-hunt stopped: the disk is nearly full">
          Less than 1 GB is free where wg-hunt keeps its data. Free some space, or delete old data
          under Stored data below, then switch Keep hunting back on.
        </Notice>
      )}

      <div className="adv-tiles">
        <TodayTile view={view} />
        <NextJobsTile view={view} />
        <ForecastTile api={api} events={events} refresh={`${saved}:${refresh}:${halfBudget}`} />
      </div>

      {/* Not remounted when the main settings save the pacing: that would lose a draft here. */}
      <PacingEditor
        api={api}
        onSaved={() => {
          setSaved((n) => n + 1);
          onSaved();
        }}
        refresh={`${saved}:${halfBudget}`}
        outside={refresh}
      />
      <RequestLog api={api} events={events} />
    </Section>
  );
}

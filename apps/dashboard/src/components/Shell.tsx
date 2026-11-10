import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { AnalysisContext, useAnalysis } from "../analysis.js";
import type { ApiClient } from "../api/client.js";
import { SeekingDraftProvider, SettingsDraftProvider } from "../draft.js";
import type { EventStream } from "../events.js";
import { HuntStatusProvider } from "../hunt-status.js";
import { OfferCountsProvider } from "../offer-counts.js";
import { Suspended } from "../ui/suspended.js";
import { ConnectionNotice } from "./ConnectionNotice.js";
import { HuntAlert } from "./HuntAlert.js";
import { NavRail } from "./NavRail.js";
import { TopBarSlot } from "./TopBar.js";

export function Shell({
  api,
  events,
  inert = false,
  children,
}: {
  api: ApiClient;
  events: EventStream;
  inert?: boolean;
  children: ReactNode;
}) {
  const main = useRef<HTMLElement>(null);
  const analysis = useAnalysis(api, events);
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  // The body outlives the page in it, so it would keep the last page's scroll; a new page starts on top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on purpose whenever the path changes
  useEffect(() => {
    body.current?.scrollTo?.({ top: 0 });
  }, [pathname]);

  function skipToContent(event: MouseEvent) {
    event.preventDefault();
    main.current?.focus();
  }

  return (
    <Suspended.Provider value={inert}>
      <OfferCountsProvider api={api} events={events}>
        <HuntStatusProvider api={api} events={events}>
          <SeekingDraftProvider>
            <SettingsDraftProvider>
              <div className="shell" inert={inert}>
                {/* biome-ignore lint/a11y/useValidAnchor: a skip link; the handler only moves focus, since jsdom and the router ignore the fragment */}
                <a href="#main" className="skip-link" onClick={skipToContent}>
                  Skip to content
                </a>
                <AnalysisContext.Provider value={analysis}>
                  <NavRail />
                  <main id="main" ref={main} tabIndex={-1} className="sheet">
                    <div ref={setHead} className="sheet-head" />
                    <ConnectionNotice events={events} />
                    <HuntAlert />
                    <TopBarSlot.Provider value={head}>
                      <div ref={body} className="sheet-body">
                        {children}
                      </div>
                    </TopBarSlot.Provider>
                  </main>
                </AnalysisContext.Provider>
              </div>
            </SettingsDraftProvider>
          </SeekingDraftProvider>
        </HuntStatusProvider>
      </OfferCountsProvider>
    </Suspended.Provider>
  );
}

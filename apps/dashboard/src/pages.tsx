import { Navigate, Route, Routes, useLocation, useParams } from "react-router";
import type { ApiClient } from "./api/client.js";
import { OfferPage } from "./components/OfferPage.js";
import { OffersPage } from "./components/OffersPage.js";
import { OverviewPage } from "./components/OverviewPage.js";
import { ProfileFiltersPage } from "./components/ProfileFiltersPage.js";
import { SearchesPage } from "./components/SearchesPage.js";
import { TopBar } from "./components/TopBar.js";
import type { EventStream } from "./events.js";
import { BANDS } from "./nav.js";
import { SettingsPage } from "./settings/SettingsPage.js";

function OffersHome() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/offers/match", search }} replace />;
}

function BandPage({ api, events }: { api: ApiClient; events: EventStream }) {
  const { band: id } = useParams();
  if (id === "all") return <OffersPage api={api} events={events} />;
  if (id === "shortlisted") return <OffersPage api={api} events={events} shortlisted />;
  const band = BANDS.find((b) => b.id === id);
  if (!band) return <NotFound />;
  return <OffersPage api={api} events={events} band={band.id} />;
}

function NotFound() {
  return (
    <>
      <TopBar title="Page not found" />
      <p className="muted">There is nothing at this address. Use the menu to find your way.</p>
    </>
  );
}

export function Pages({
  api,
  events,
  onSignOut,
}: {
  api: ApiClient;
  events: EventStream;
  onSignOut: () => void;
}) {
  return (
    <Routes>
      <Route path="/" element={<OverviewPage api={api} events={events} />} />
      <Route path="/offers" element={<OffersHome />} />
      <Route path="/offers/:band" element={<BandPage api={api} events={events} />} />
      <Route path="/offer/:id" element={<OfferPage />} />
      <Route path="/profile" element={<ProfileFiltersPage api={api} events={events} />} />
      <Route path="/searches" element={<SearchesPage api={api} events={events} />} />
      <Route path="/crawl" element={<Navigate to="/settings" replace />} />
      <Route
        path="/settings"
        element={<SettingsPage api={api} events={events} onSignOut={onSignOut} />}
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

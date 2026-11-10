import { NavLink } from "react-router";
import { useSeekingDraft, useSettingsDraft } from "../draft.js";
import { BOTTOM_PAGES, type NavPage, PAGES } from "../nav.js";
import { useOfferCounts } from "../offer-counts.js";
import { Icon } from "../ui/Icon.js";

export function NavRail() {
  const profileDraft = useSeekingDraft().held !== null;
  const settings = useSettingsDraft();
  const settingsDraft = settings.pacing !== null || settings.analysis !== null;
  const { counts } = useOfferCounts();
  const newOffers = counts?.new ?? 0;

  function item(page: NavPage) {
    return (
      <NavLink to={page.path} end={page.end} className="rail-item">
        <span className="rail-tile">
          <Icon name={page.icon} size={22} />
          {page.path === "/offers" && newOffers > 0 && (
            <span className="rail-badge">
              {newOffers > 999 ? "999+" : newOffers}
              <span className="wh-sr"> new</span>
            </span>
          )}
          {((page.path === "/profile" && profileDraft) ||
            (page.path === "/settings" && settingsDraft)) && (
            <span className="rail-dot" role="img" aria-label="Unsaved draft" />
          )}
        </span>
        <span className="rail-label">{page.label}</span>
      </NavLink>
    );
  }

  return (
    <aside className="rail">
      <nav aria-label="Main" className="rail-nav">
        <ul className="rail-list">
          {PAGES.map((page) => (
            <li key={page.path}>{item(page)}</li>
          ))}
        </ul>
        <ul className="rail-list rail-foot">
          {BOTTOM_PAGES.map((page) => (
            <li key={page.path}>{item(page)}</li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

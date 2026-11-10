import type { IconName } from "./ui/Icon.js";

/** The Offers bands, in list order. */
export const BANDS = [
  { id: "match", label: "Match", family: "match" },
  { id: "near-match", label: "Near match", family: "near" },
  { id: "warned", label: "Warned", family: "warned" },
  { id: "hidden", label: "Hidden", family: "hidden" },
] as const;

export type NavPage = { path: string; label: string; icon: IconName; end?: boolean };

/** On a phone these and Settings are the bottom bar's five tabs. */
export const PAGES: readonly NavPage[] = [
  { path: "/", label: "Overview", icon: "home", end: true },
  { path: "/offers", label: "Offers", icon: "offers" },
  { path: "/searches", label: "Searches", icon: "radar" },
  { path: "/profile", label: "Profile", icon: "user" },
];

export const BOTTOM_PAGES: readonly NavPage[] = [
  { path: "/settings", label: "Settings", icon: "settings" },
];

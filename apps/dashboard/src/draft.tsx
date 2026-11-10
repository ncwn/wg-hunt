import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { HeldPacing } from "./components/PacingEditor.js";
import type { Saved, Seeking } from "./seeking.js";
import type { HeldAnalysis } from "./settings/AnalysisSection.js";

/**
 * The seeker's unsaved Profile and Filters, with the saved copy they were made from, so the draft
 * can be laid over a newer saved copy instead of saving the old one back.
 */
export type HeldDraft = { base: Saved; draft: Seeking };

type SeekingDraft = {
  /** Null when nothing differs from what is saved. */
  held: HeldDraft | null;
  setHeld: Dispatch<SetStateAction<HeldDraft | null>>;
};

const Context = createContext<SeekingDraft>({ held: null, setHeld: () => {} });

/** Held above the pages so it survives a visit to another page and the nav rail can mark it. */
export function SeekingDraftProvider({ children }: { children: ReactNode }) {
  const [held, setHeld] = useState<HeldDraft | null>(null);
  useUnsavedGuard(held !== null);
  const value = useMemo(() => ({ held, setHeld }), [held]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useSeekingDraft = () => useContext(Context);

type SettingsDraft = {
  /** Each null when that form has nothing unsaved. */
  pacing: HeldPacing | null;
  setPacing: Dispatch<SetStateAction<HeldPacing | null>>;
  analysis: HeldAnalysis | null;
  setAnalysis: Dispatch<SetStateAction<HeldAnalysis | null>>;
};

const SettingsContext = createContext<SettingsDraft>({
  pacing: null,
  setPacing: () => {},
  analysis: null,
  setAnalysis: () => {},
});

export function SettingsDraftProvider({ children }: { children: ReactNode }) {
  const [pacing, setPacing] = useState<HeldPacing | null>(null);
  const [analysis, setAnalysis] = useState<HeldAnalysis | null>(null);
  useUnsavedGuard(pacing !== null || analysis !== null);
  const value = useMemo(() => ({ pacing, setPacing, analysis, setAnalysis }), [pacing, analysis]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export const useSettingsDraft = () => useContext(SettingsContext);

export function useUnsavedGuard(unsaved: boolean) {
  useEffect(() => {
    if (!unsaved) return;
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when this is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [unsaved]);
}

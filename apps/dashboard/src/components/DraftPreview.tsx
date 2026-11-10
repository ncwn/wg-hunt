import { useEffect, useState } from "react";
import { BANDS } from "../nav.js";
import type { PreviewState, RankingPreview } from "../seeking.js";
import { Button } from "../ui/Button.js";
import { BandTag, Disclosure, Notice } from "../ui/status.js";
import { FILTER_QUESTIONS } from "./FiltersEditor.js";
import { PROFILE_QUESTIONS } from "./ProfileEditor.js";

const bandOf = (id: string) => BANDS.find((band) => band.id === id) ?? BANDS[0];
const Tag = ({ id }: { id: string }) => <BandTag band={bandOf(id).family} />;

const PLACE_PARTS: Record<string, string> = {
  name: "name",
  plz: "PLZ",
  lat: "latitude",
  lng: "longitude",
};

function whereIs(path: string): string | undefined {
  const parts = path.split(".");
  const side = parts[0] === "filters" || parts[0] === "profile" ? parts.shift() : undefined;
  const [key, index, part] = parts;
  if (key === undefined) return undefined;
  if (side !== "profile" && key in FILTER_QUESTIONS) {
    return FILTER_QUESTIONS[key as keyof typeof FILTER_QUESTIONS].title;
  }
  if (side === "filters") return undefined;
  if (key === "places" && index !== undefined && /^\d+$/.test(index)) {
    const place = `Place ${Number(index) + 1}`;
    return part && PLACE_PARTS[part] ? `${place} ${PLACE_PARTS[part]}` : place;
  }
  return key in PROFILE_QUESTIONS
    ? PROFILE_QUESTIONS[key as keyof typeof PROFILE_QUESTIONS]
    : undefined;
}

const LISTED = 8;

const headline = (n: number) =>
  n === 0
    ? "No Offer would be ranked differently"
    : `${n} ${n === 1 ? "Offer would" : "Offers would"} be ranked differently`;

function useNarrow() {
  const query = "(max-width: 1024px)";
  const [narrow, setNarrow] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const change = () => setNarrow(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return narrow;
}

function Moves({ preview }: { preview: RankingPreview }) {
  const { changes, counts } = preview;
  return (
    <>
      <p className="dp-headline">{headline(changes.length)}</p>
      {changes.length > 0 && (
        <ul className="dp-moves" aria-label="What would move">
          {changes.slice(0, LISTED).map((change) => (
            <li key={change.offerId}>
              <span className="dp-title">{change.title}</span>
              <span className="dp-move">
                <Tag id={change.from} />
                <span className="wh-sr">to</span>
                <span aria-hidden="true">→</span>
                <Tag id={change.to} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {changes.length > LISTED && <p className="dp-caption">…and {changes.length - LISTED} more</p>}
      <table className="dp-counts">
        <caption className="wh-sr">Offers per band, now and with these changes</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="wh-sr">Band</span>
            </th>
            <th scope="col">Now</th>
            <th scope="col">With changes</th>
          </tr>
        </thead>
        <tbody>
          {BANDS.map((band) => {
            const before = counts.before[band.id];
            const after = counts.after[band.id];
            return (
              <tr key={band.id}>
                <th scope="row">
                  <Tag id={band.id} />
                </th>
                <td className="wh-num">{before}</td>
                <td className={`wh-num${before !== after ? " dp-changed" : ""}`}>{after}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export function DraftPreview({
  preview,
  saving,
  onSave,
  onDiscard,
  onRetry,
  saveError,
}: {
  preview: PreviewState;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  saveError?: string | undefined;
}) {
  const narrow = useNarrow();
  const shown =
    preview.status === "ready"
      ? preview.preview
      : preview.status === "loading"
        ? preview.last
        : undefined;

  const moves = shown && <Moves preview={shown} />;
  return (
    <>
      <h2 className="dp-heading">Unsaved changes</h2>
      <div aria-live="polite" className="dp-body">
        {narrow && moves ? (
          <Disclosure title={headline(shown?.changes.length ?? 0)} className="dp-fold">
            {moves}
          </Disclosure>
        ) : (
          moves
        )}
        {preview.status === "loading" && (
          <p className="dp-caption" role="status">
            {shown ? "Updating…" : "Working out what changes…"}
          </p>
        )}
        {preview.status === "failed" && (
          <div className="pf-problem">
            <Notice tone="alarm" title="Couldn't work out what changes" defaultOpen>
              {preview.message}
            </Notice>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {preview.status === "invalid" && (
          <Notice tone="alarm" title="This can't be previewed yet" defaultOpen>
            {preview.problem.errors.length > 0 ? (
              <ul className="dp-errors">
                {preview.problem.errors.map((error) => {
                  const where = whereIs(error.path);
                  return (
                    <li key={`${error.path}:${error.message}`}>
                      {where && <span className="dp-where">{where}</span>} {error.message}
                    </li>
                  );
                })}
              </ul>
            ) : (
              preview.problem.message
            )}
          </Notice>
        )}
        {saveError && <Notice tone="alarm">{saveError}</Notice>}
      </div>
      <div className="dp-actions">
        <Button variant="primary" onClick={onSave} disabled={saving || preview.status !== "ready"}>
          Save
        </Button>
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
      </div>
    </>
  );
}

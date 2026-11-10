export type StatTone = "lavender" | "mint" | "butter";

export function StatCard({
  tone = "lavender",
  label,
  value,
  note,
  onClick,
}: {
  tone?: StatTone;
  label: string;
  value: string | number;
  note?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <p className="wh-stat-label">{label}</p>
      <div className="wh-stat-bottom">
        <p className="wh-stat-value">{value}</p>
        {note && <span className="wh-stat-note">{note}</span>}
      </div>
    </>
  );
  const classes = `wh-card wh-stat wh-stat-${tone}`;
  return onClick ? (
    <button type="button" className={`${classes} is-link`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={classes}>{body}</div>
  );
}

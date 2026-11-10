export function Logo() {
  return (
    <span className="wh-logo">
      <svg width={40} height={40} viewBox="0 0 48 48" role="img" aria-label="wg-hunt">
        <title>wg-hunt</title>
        <rect width={48} height={48} rx={12} className="wh-logo-tile" />
        <path d="M24 10.5 9.5 21.8V37.5h29V21.8z" className="wh-logo-ink" />
        <circle cx={22.6} cy={27.4} r={4.4} fill="none" strokeWidth={2.6} className="wh-logo-cut" />
        <path
          d="M25.9 30.7l3.4 3.4"
          fill="none"
          strokeWidth={2.8}
          strokeLinecap="round"
          className="wh-logo-cut"
        />
      </svg>
      <span className="wh-logo-name" aria-hidden="true">
        wg-hunt
      </span>
    </span>
  );
}

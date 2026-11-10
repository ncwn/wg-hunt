const ICONS = {
  home: "M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z",
  offers: "M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z",
  star: "M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z",
  radar:
    "M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0M8.5 12a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0M12 12l5.6-5.6",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20.5a7.5 7.5 0 0 1 15 0",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
  logout: "M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 8l-4 4 4 4M6 12h9",
  calendar:
    "M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1zM4 10h16M8 3.5v4M16 3.5v4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  chevronDown: "M6.5 9.5 12 15l5.5-5.5",
  chevronRight: "M9.5 6.5 15 12l-5.5 5.5",
  chevronLeft: "M14.5 6.5 9 12l5.5 5.5",
  plus: "M12 5v14M5 12h14",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4",
  external: "M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  pause: "M9 5.5v13M15 5.5v13",
  play: "M7.5 5.5 18.5 12l-11 6.5z",
  message: "M4.5 5h15v11H9.5l-5 4z",
  house: "M4 11 12 4l8 7v9H4zM10 20v-5h4v5",
  expand: "M14 4.5h5.5V10M19.5 4.5 13.5 10.5M10 19.5H4.5V14M4.5 19.5l6-6",
  sparkle: "M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? `wh-icon ${className}` : "wh-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/**
 * DaceraLogo — Docera brand mark.
 *
 * variant="full"  → icon badge + "Docera" wordmark (header, splash)
 * variant="icon"  → icon badge only (app icon, nav)
 *
 * size (icon variant only):
 *   "sm"  28×28  "md"  36×36  "lg"  64×64
 */

interface DaceraLogoProps {
  variant?: "full" | "icon";
  size?: "sm" | "md" | "lg";
  subtitle?: string;
  className?: string;
}

const ICON_SIZE = {
  sm: { cls: "w-7 h-7",   r: "rounded-[10px]", px: 16 },
  md: { cls: "w-9 h-9",   r: "rounded-[12px]", px: 20 },
  lg: { cls: "w-16 h-16", r: "rounded-[20px]", px: 36 },
} as const;

/**
 * The "D" mark — a bold hollow geometric D letterform.
 *
 * Built with evenodd so the counter (inner open space) punches through
 * to the background, keeping the icon sharp at any size.
 *
 * Outer D:  M3 2 H8 C13 2 17.5 5.5 17.5 10 C17.5 14.5 13 18 8 18 H3 Z
 * Counter:  M6 5 H9 C12 5 14.5 7 14.5 10 C14.5 13 12 15 9 15 H6 Z
 *
 * Stroke weights (in 20px viewBox units):
 *   left bar  = 3     top / bottom arms = 3     right bow = 3
 */
function DMark({ px }: { px: number }) {
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={[
          /* outer D silhouette */
          "M3 2 H8 C13 2 17.5 5.5 17.5 10 C17.5 14.5 13 18 8 18 H3 Z",
          /* counter — punches through with evenodd */
          "M6 5 H9 C12 5 14.5 7 14.5 10 C14.5 13 12 15 9 15 H6 Z",
        ].join(" ")}
        fill="#e8e8ec"
      />
    </svg>
  );
}

export function DaceraLogo({
  variant = "full",
  size = "md",
  subtitle,
  className = "",
}: DaceraLogoProps) {

  /* ── Icon badge (shared by both variants) ─────────────────────────────── */
  const { cls, r, px } = ICON_SIZE[size];

  const badge = (badgeCls = "") => (
    <div
      className={`${badgeCls} flex items-center justify-center flex-shrink-0`}
      style={{ backgroundColor: "#113e61", borderRadius: variant === "full" ? 12 : undefined }}
    >
      <DMark px={px} />
    </div>
  );

  /* ── Full: badge + wordmark ───────────────────────────────────────────── */
  if (variant === "full") {
    return (
      <div className={`flex flex-col justify-center ${className}`}>
        <div className="flex items-center gap-2.5">
          {/* icon badge — fixed size for full variant */}
          <div
            className="w-9 h-9 flex items-center justify-center flex-shrink-0 shadow-sm"
            style={{ backgroundColor: "#113e61", borderRadius: 12 }}
          >
            <DMark px={20} />
          </div>
          {/* wordmark */}
          <span
            className="select-none leading-none"
            style={{
              color: "#113e61",
              fontFamily: "'Space Grotesk', system-ui, sans-serif",
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.03em",
            }}
          >
            Docera
          </span>
        </div>
        {subtitle && (
          <span className="text-[11px] text-muted-foreground leading-tight mt-1.5 ml-0.5 block">
            {subtitle}
          </span>
        )}
      </div>
    );
  }

  /* ── Icon only ────────────────────────────────────────────────────────── */
  return (
    <div
      className={`${cls} ${r} flex items-center justify-center flex-shrink-0 shadow-sm ${className}`}
      style={{ backgroundColor: "#113e61" }}
    >
      <DMark px={px} />
    </div>
  );
}

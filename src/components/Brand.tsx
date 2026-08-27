/**
 * The app's mark and wordmark.
 *
 * Inline SVG rather than an image file, for three reasons that matter here: it
 * inherits the theme's gradient tokens instead of baking colours into a binary,
 * it stays sharp at any size on any display, and it needs no network request —
 * which matters most on the sign-in page, the one screen a new user judges the
 * whole application by before they have any reason to trust it.
 *
 * The mark is a document with a check mark rising out of it: the application is
 * a resume that got through. It reads at 24px in the nav and at 56px on the
 * sign-in card without redrawing.
 *
 * `gradientId` exists because an SVG gradient is referenced by a document-unique
 * id. Two logos on one page sharing an id makes the second one render with the
 * first one's fill, which is exactly what happens when the nav and a card are
 * visible together.
 */
export function LogoMark({ size = 32, gradientId = 'brandMark' }: { size?: number; gradientId?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Job Assistant"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a06bff" />
          <stop offset="0.5" stopColor="#ff6bd6" />
          <stop offset="1" stopColor="#ffa14a" />
        </linearGradient>
      </defs>

      <rect x="1.5" y="1.5" width="45" height="45" rx="12" fill={`url(#${gradientId})`} />

      {/* The document: three lines of a resume, deliberately uneven so it reads
          as text rather than as a table. */}
      <rect x="13" y="12" width="22" height="26" rx="3" fill="#ffffff" opacity="0.92" />
      <rect x="17" y="18" width="14" height="2.2" rx="1.1" fill="#7c3aed" opacity="0.55" />
      <rect x="17" y="23" width="10" height="2.2" rx="1.1" fill="#7c3aed" opacity="0.55" />
      <rect x="17" y="28" width="12" height="2.2" rx="1.1" fill="#7c3aed" opacity="0.35" />

      {/* The check, breaking the document's edge so it reads as an outcome
          rather than as a tick box inside a form. */}
      <path
        d="M25.5 32.5l4.6 4.8L41 26.5"
        stroke="#ffffff"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M25.5 32.5l4.6 4.8L41 26.5"
        stroke="#059669"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const text = size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-base' : 'text-lg';
  return (
    <span className={`font-display ${text} font-extrabold tracking-tight`}>
      <span className="text-gradient">Job</span>
      <span className="text-[var(--color-fg)]">Assistant</span>
    </span>
  );
}

/** Mark and wordmark together, for the nav and the auth pages. */
export function Brand({
  size = 'md',
  gradientId = 'brandMark',
}: {
  size?: 'sm' | 'md' | 'lg';
  gradientId?: string;
}) {
  const px = size === 'lg' ? 44 : size === 'sm' ? 24 : 30;
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={px} gradientId={gradientId} />
      <Wordmark size={size} />
    </span>
  );
}

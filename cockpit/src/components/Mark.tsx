/**
 * The wordmark's glyph: three bars on a shared left edge, which is the whole
 * product in miniature — one row per turn, drawn against the same axis.
 */
export function Mark() {
  return (
    <svg className="mark-glyph" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="0" y="2" width="11" height="3" rx="1.5" fill="var(--stage-eou)" />
      <rect x="0" y="7.5" width="16" height="3" rx="1.5" fill="var(--stage-ttft)" />
      <rect x="0" y="13" width="7" height="3" rx="1.5" fill="var(--stage-ttfb)" />
    </svg>
  );
}

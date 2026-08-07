import {
  CONTACT_EMAIL,
  GRAFANA_PUBLIC_URL,
  LINKEDIN_URL,
  REPO_URL,
  SITE_URL,
} from '../config';

/**
 * Rendered on every view, because any of them can be the first page someone is
 * sent — a shared debrief and a `/live` link both skip the hero entirely.
 *
 * External links carry `rel="noreferrer"`: a debrief URL is a capability, and it
 * should not travel out in a Referer header to a third party.
 */
const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: SITE_URL, label: 'agentmaker.io' },
  { href: REPO_URL, label: 'GitHub' },
  { href: LINKEDIN_URL, label: 'LinkedIn' },
  { href: `mailto:${CONTACT_EMAIL}`, label: CONTACT_EMAIL },
  { href: GRAFANA_PUBLIC_URL, label: 'Fleet dashboard' },
];

export function Footer() {
  return (
    <footer className="footer">
      <span>Built by Steve Greszczyszyn</span>
      {LINKS.map(({ href, label }) => (
        <span key={href} className="footer__item">
          <span className="footer__sep">/</span>
          <a href={href} rel="noreferrer">
            {label}
          </a>
        </span>
      ))}
    </footer>
  );
}

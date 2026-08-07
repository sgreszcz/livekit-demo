import {
  CONTACT_EMAIL,
  GRAFANA_PUBLIC_URL,
  LINKEDIN_URL,
  REPO_URL,
  SITE_URL,
} from '../config';

/**
 * Pinned to the bottom of the viewport on every view, because any of them can be
 * the first page someone is sent — a shared debrief and a `/live` link both skip
 * the hero — and because these links are the point of the page for a reader who
 * has just watched the instruments and wants to know who built them. A footer
 * that has to be scrolled to is a footer most readers never reach.
 *
 * Separators were dropped when it became a wrapping bar: an item carrying its
 * own leading slash puts a dangling one at the start of any wrapped row, and
 * spacing reads as cleanly without them.
 */
interface FooterLink {
  href: string;
  label: string;
  /** A mailto: hands off to a mail client; a new tab there is an empty window. */
  external: boolean;
}

const LINKS: readonly FooterLink[] = [
  { href: SITE_URL, label: 'agentmaker.io', external: true },
  { href: REPO_URL, label: 'GitHub', external: true },
  { href: LINKEDIN_URL, label: 'LinkedIn', external: true },
  { href: `mailto:${CONTACT_EMAIL}`, label: CONTACT_EMAIL, external: false },
  { href: GRAFANA_PUBLIC_URL, label: 'Fleet dashboard', external: true },
];

export function Footer() {
  return (
    <footer className="footer">
      <span className="footer__by">Built by Steve Greszczyszyn</span>
      {LINKS.map(({ href, label, external }) => (
        <a
          key={href}
          href={href}
          // Leaving for GitHub or Grafana should not cost the reader the call
          // they were watching: an observer session ends when the tab navigates.
          {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        >
          {label}
        </a>
      ))}
    </footer>
  );
}

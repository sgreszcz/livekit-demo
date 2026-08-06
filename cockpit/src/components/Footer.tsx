import { REPO_URL, SITE_URL } from '../config';

export function Footer() {
  return (
    <footer className="footer">
      <span>Built by Steve Greszczyszyn</span>
      <span className="footer__sep">/</span>
      <a href={SITE_URL} rel="noreferrer">
        agentmaker.io
      </a>
      <span className="footer__sep">/</span>
      <a href={REPO_URL} rel="noreferrer">
        GitHub repo
      </a>
    </footer>
  );
}

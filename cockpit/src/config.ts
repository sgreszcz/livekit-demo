/**
 * Build-time configuration.
 *
 * The inbound number is live: a caller on a real phone reaches the same agent
 * as the browser button, over the SIP trunk. Two forms are kept because they
 * are read by different things — `PHONE_E164` is what a `tel:` link dials,
 * `PHONE_DISPLAY` is what a human reads off the placard. A fork pointed at a
 * different trunk overrides both; if it sets only the number, the placard
 * prints the E.164 form rather than guessing at a country's grouping.
 */

const env = import.meta.env;

const numberOverride = env.VITE_PHONE_NUMBER?.trim();
const displayOverride = env.VITE_PHONE_DISPLAY?.trim();

/** E.164, digits only after the plus — the string a `tel:` link dials. */
export const PHONE_E164: string = numberOverride || '+442046527116';

/** The same number, grouped for reading and for dialling by hand. */
export const PHONE_DISPLAY: string = displayOverride || numberOverride || '+44 20 4652 7116';

export const SITE_URL = 'https://agentmaker.io';

/**
 * The same aggregate the dashboard draws, in Grafana.
 *
 * Linked rather than hidden: `/api/metrics` is public and uncredentialed by
 * design, this page and that dashboard scrape the identical body, and saying so
 * is cheaper than being caught claiming two sources agree when nobody can check.
 */
export const GRAFANA_URL = 'https://agentmaker.grafana.net/d/glass-cockpit-fleet';

export const REPO_URL: string = env.VITE_REPO_URL ?? 'https://github.com/sgreszcz/livekit-demo';

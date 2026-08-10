export interface Env {
  /** Stored call debriefs, keyed by short id, 90-day TTL. */
  DEBRIEFS: KVNamespace;

  /**
   * Month-to-date agent usage, one key per UTC month. Deliberately NOT in
   * DEBRIEFS: /api/metrics lists that namespace and reads what it finds, so a
   * counter stored there would show up as an unreadable call and spend a read
   * out of the endpoint's budget. See alerts.ts.
   */
  USAGE: KVNamespace;

  /** LiveKit Cloud project credentials. Secrets — never leave this Worker. */
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  /** wss:// URL handed to the browser alongside the signed token. */
  LIVEKIT_URL: string;

  /** Shared secret the Python agent presents when it posts a debrief. */
  DEBRIEF_TOKEN?: string;

  /**
   * Cloudflare Email Sending. Optional: absent in local dev and in any
   * deployment where the binding has not been added, and alerts.ts answers with
   * a named outcome rather than failing the request that triggered it.
   */
  EMAIL?: SendEmail;

  /**
   * Shared secret in the `?key=` of the Twilio usage-trigger callback URL. Unset
   * disables `POST /api/alerts/twilio` entirely — see `handleTwilioAlert`.
   */
  ALERT_WEBHOOK_KEY?: string;

  /**
   * Comma-separated agent-minute thresholds to mail at, e.g. "500,800". Unset
   * means the default; set to an empty string to disable minute alerts.
   */
  USAGE_ALERT_MINUTES?: string;
}

export interface Env {
  /** Stored call debriefs, keyed by short id, 90-day TTL. */
  DEBRIEFS: KVNamespace;

  /** LiveKit Cloud project credentials. Secrets — never leave this Worker. */
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  /** wss:// URL handed to the browser alongside the signed token. */
  LIVEKIT_URL: string;

  /** Shared secret the Python agent presents when it posts a debrief. */
  DEBRIEF_TOKEN?: string;
}

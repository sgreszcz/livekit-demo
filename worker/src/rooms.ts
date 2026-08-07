/**
 * Room names: the one identifier in this system that carries PII.
 *
 * A browser call gets `cockpit-<random>` from token.ts and is meaningless on its
 * own. A phone call does not: LiveKit's SIP dispatch names the room after the
 * trunk and a *phone number* — `sip-cockpit-_+447700900123_BXhCPPSrr57t` — so
 * anything that echoes a room name back to a client can publish a stranger's
 * phone number. /api/active is polled by every anonymous visitor on the front
 * page, and a stored debrief is fetched by anyone holding its share link, so
 * both are publication.
 *
 * Two operations, and the order between them is load-bearing:
 *
 *  * `roomId` is the *opaque handle* clients get instead of a name. It hashes
 *    the REAL name, because the observer flow has to map the handle back to the
 *    room it names (see `resolveRoomId` in active.ts) and a redacted name is not
 *    the name LiveKit knows.
 *  * `redactRoomName` is for anything that gets *stored or displayed*. It is
 *    lossy on purpose and must never be fed to `roomId`.
 *
 * Hashing is not a secret: the id is derived from a public-ish name with no
 * key, so a determined party holding a candidate number could confirm it by
 * hashing. That is why the id is only ever *resolved against rooms that are
 * live right now* — the handle is a pointer into the current call list, not a
 * durable identifier, and it stops meaning anything the moment the call ends.
 */

/**
 * A run of digits long enough to be a phone number, with the optional `+` that
 * makes it E.164.
 *
 * Seven digits rather than six: the shortest numbers anyone dials are seven,
 * and every extra digit required makes a false positive that much less likely.
 * A false positive costs a mangled cosmetic string in a stored debrief and
 * nothing else, which is the right way round for a redaction rule to be wrong.
 *
 * Separators are allowed BETWEEN the digits — `+44-7700-900123`, `(0770) 090
 * 0123` — because a rule that only matches an unbroken run is trivially evaded
 * by the way humans actually write numbers, and the room-name grammar itself
 * permits `-` and `_`. The separators are then stripped and the DIGITS counted,
 * so a hyphenated base62 id with a couple of digits in it is not mistaken for a
 * phone number.
 */
const PHONE_RUN = /\+?\d[\d\s().-]{5,}\d/g;

/** Digits only, for counting. */
const NON_DIGIT = /\D/g;

/** An unbroken run this long is a phone number. Nothing else here is. */
const MIN_PHONE_DIGITS = 7;
/**
 * When separators are involved, more digits are required.
 *
 * Allowing separators is what catches `+44-7700-900123`, but it also matches
 * `2026-08-07` — eight digits, and a date, not a number. Real dialable numbers
 * are longer: E.164 runs to fifteen digits and a UK mobile is eleven, so nine
 * cleanly separates them from dates and version strings while still catching
 * every way a person writes a phone number.
 */
const MIN_SEPARATED_DIGITS = 9;

/** What a redacted number is replaced with. Recognisable, and never a number. */
export const REDACTED = '+REDACTED';

/** Opaque room handles: 16 lowercase hex characters, and nothing else. */
export const ROOM_ID = /^[0-9a-f]{16}$/;

/** Hex characters kept from the digest. 64 bits — far past collision risk for a
 *  list that is capped at ten live rooms. */
const ROOM_ID_LENGTH = 16;

/**
 * Strip caller numbers from a room name, keeping its shape.
 *
 * `sip-cockpit-_+447700900123_BXhCPPSrr57t` → `sip-cockpit-_+REDACTED_BXhCPPSrr57t`.
 * The `sip-cockpit-` prefix survives (entry classification reads it) and so does
 * the random suffix (it is what makes one call distinguishable from another),
 * while the only field a person could be identified by is gone.
 */
export function redactRoomName(name: string): string {
  return name.replace(PHONE_RUN, (match) => {
    const digits = match.replace(NON_DIGIT, '');
    // `+` is punctuation a number legitimately starts with, not a separator.
    const separated = /[^\d+]/.test(match);
    const needed = separated ? MIN_SEPARATED_DIGITS : MIN_PHONE_DIGITS;
    return digits.length >= needed ? REDACTED : match;
  });
}

/**
 * Redact phone numbers from every string in a JSON value, recursively.
 *
 * `redactRoomName` only ever gets pointed at fields somebody remembered to
 * point it at, which is a rule that holds until the first new field. A room
 * name reaches storage through `meta.room` and the `call_meta` payload today,
 * but a SIP identity, a participant attribute, a `metadata` blob or a caller
 * reading their own number aloud into a transcript are all the same leak with a
 * different key, and an anonymous browser can mint a public share link carrying
 * any of them. Scrubbing by SHAPE rather than by field name is the version that
 * keeps working.
 *
 * Structure is preserved exactly: only string leaves are rewritten, so numbers
 * — including the unix timestamps that would be mangled by a naive scrub of the
 * serialised JSON — are untouched.
 */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactRoomName(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(item);
    }
    return out;
  }
  return value;
}

/**
 * The opaque handle for a room. Always pass the REAL name — see the module note.
 */
export async function roomId(name: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, ROOM_ID_LENGTH);
}

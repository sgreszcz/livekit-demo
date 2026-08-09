/**
 * The keep-warm ping: a room created purely so the agent container has to wake up.
 *
 * LiveKit does not answer an inbound SIP call until an agent joins the room, and LiveKit
 * Cloud stops an agent container that has been idle. Measured on the live demo number:
 * twelve seconds of ringing on a cold worker against three on a warm one, and the agent's
 * own logs put eleven of those twelve in container boot — "initializing process",
 * "registered worker" and "received job request" all landed within 200ms of each other at
 * T+11s. The plan exposes no min-replica or always-warm setting, so the only lever left is
 * to give the container something to do often enough that it never stops.
 *
 * That something is a room. Agent dispatch is automatic — the Python agent registers with
 * no `agent_name` — so creating ANY room dispatches it, which is the cheapest possible way
 * to make LiveKit Cloud go and find a worker. The agent recognises the `warmup-` prefix and
 * refuses the job at request time (`on_request` in agent/agent.py), so no agent session is
 * ever started and no session minutes are metered; what gets paid for is the container
 * boot, which is the thing being bought.
 *
 * Three properties this module is responsible for, all of them about a warm-up never being
 * mistaken for a call:
 *
 *  * **Invisible.** A `warmup-` room matches neither prefix `classifyEntry` knows, so it
 *    cannot appear in /api/active, cannot be resolved to a `room_id`, and cannot be
 *    observed. It produces no debrief, so it never reaches /api/metrics either. Asserted
 *    in warmup.test.ts rather than assumed.
 *  * **Short-lived.** Deleted explicitly the moment it has served its purpose, with a
 *    one-second empty/departure timeout as the backstop for a delete that fails.
 *  * **Silent when it would be pointless.** A call already in progress means the container
 *    is already warm, and a warm-up fired into a live call buys nothing.
 */

import { RoomServiceClient } from 'livekit-server-sdk';
import { apiHost, liveCallStatus, type RoomsApi } from './active';
import type { Env } from './env';
import { randomId } from './http';

/**
 * The contract with agent/agent.py, where the same string is `WARMUP_ROOM_PREFIX`.
 *
 * Deliberately shares no prefix with anything else in the system. `classifyEntry` in
 * active.ts recognises `sip-cockpit-` and `cockpit-`; `OBSERVABLE_ROOM` in token.ts demands
 * a `cockpit-` prefix. `warmup-` satisfies neither, which is what makes a warm-up room
 * structurally incapable of showing up anywhere a visitor can see.
 */
export const WARMUP_ROOM_PREFIX = 'warmup-';

/** Suffix length. Only needs to be unique-ish; nothing resolves a warm-up room by name. */
const WARMUP_ID_LENGTH = 16;

/**
 * Empty and departure timeouts, in seconds, on a warm-up room.
 *
 * One second, not zero: the field is a uint32 where 0 means "use the server default", so
 * asking for nothing would get the project's default — minutes, typically — which is the
 * opposite of what this wants. One is the lowest value that actually means "immediately".
 *
 * This is the backstop, not the mechanism. The room is deleted explicitly below, because a
 * timeout only starts helping after it elapses and a room that lingers is a room that could
 * be listed. The timeout is what covers a `deleteRoom` that fails or a Worker invocation
 * that is cut short between the two calls.
 */
export const WARMUP_ROOM_TIMEOUT_SECONDS = 1;

/**
 * The two LiveKit calls a warm-up makes. A port, for the same reason `RoomsApi` is one:
 * the decision logic is worth testing and a Twirp fake is not worth building.
 */
export interface WarmupApi {
  createRoom(name: string): Promise<void>;
  deleteRoom(name: string): Promise<void>;
}

/**
 * What happened, for the log line. An enum rather than a boolean because "we did not ping"
 * has three quite different causes and a cron that silently stopped working looks, from the
 * outside, exactly like a cold start nobody can explain.
 */
export type WarmupOutcome =
  | 'pinged'
  | 'skipped-live-call'
  | 'no-credentials'
  | 'create-failed'
  | 'delete-failed';

/** A warm-up room name. Random suffix, so two overlapping pings cannot collide. */
export function warmupRoomName(): string {
  return `${WARMUP_ROOM_PREFIX}${randomId(WARMUP_ID_LENGTH)}`;
}

/**
 * The real port. Null when the deployment has no LiveKit credentials — the same shape
 * `roomsApiFor` uses, and for the same reason: a client that could only fail is worse than
 * an honest refusal to build one.
 *
 * The short request timeout and disabled failover are inherited from the /api/active client
 * for a different but related reason. This runs on a cron, not behind a browser, so nobody
 * is waiting — but a `scheduled` invocation that hangs for thirty seconds on a LiveKit
 * region retry is billed wall-clock for the privilege, and the next tick is only ten
 * minutes away. A ping that fails fast and is retried by the schedule is strictly better
 * than one that grinds.
 */
function warmupApiFor(env: Env): WarmupApi | null {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) return null;

  const client = new RoomServiceClient(
    apiHost(env.LIVEKIT_URL),
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
    { requestTimeout: 5, failover: false },
  );

  return {
    createRoom: async (name: string) => {
      await client.createRoom({
        name,
        emptyTimeout: WARMUP_ROOM_TIMEOUT_SECONDS,
        departureTimeout: WARMUP_ROOM_TIMEOUT_SECONDS,
      });
    },
    deleteRoom: (name: string) => client.deleteRoom(name),
  };
}

export interface WarmupDeps {
  /** Injected by tests. Falls back to a real RoomServiceClient. */
  warmup?: WarmupApi;
  /** Injected by tests, and shared with /api/active's memo in production. */
  rooms?: RoomsApi;
}

/**
 * Run one keep-warm ping. Never throws — see the `scheduled` handler in index.ts.
 *
 * "Never throws" is not defensive habit here. A `scheduled` handler that rejects is a
 * failed cron invocation, and a cron that reports failures is a cron somebody eventually
 * turns off; meanwhile every failure mode this has — LiveKit down, credentials rotated, a
 * room name that somehow already exists — is transient and answered perfectly well by
 * doing nothing and letting the next tick try again. So every outcome is a return value.
 */
export async function runWarmup(env: Env, deps: WarmupDeps = {}): Promise<WarmupOutcome> {
  const api = deps.warmup ?? warmupApiFor(env);
  if (api === null) return 'no-credentials';

  /*
   * A call in progress means the container is already warm — the agent is in that room
   * right now — so a ping would buy nothing and cost a dispatch.
   *
   * A DEGRADED answer is deliberately not treated as "a call is live". The two mistakes
   * are not equally bad: pinging unnecessarily costs one job the agent rejects in
   * milliseconds, while skipping unnecessarily costs the next caller twelve seconds of
   * ringing. And a degraded snapshot means LiveKit's room listing is unhappy, which is
   * precisely the moment to keep the agent warm rather than to stand down.
   */
  const status = await liveCallStatus(env, deps.rooms).catch(() => ({
    live: false,
    degraded: true,
  }));
  if (status.live) return 'skipped-live-call';

  const name = warmupRoomName();

  try {
    await api.createRoom(name);
  } catch {
    // Nothing was created, so there is nothing to clean up.
    return 'create-failed';
  }

  /*
   * Deleted rather than left to expire. `emptyTimeout` would get there on its own, but
   * "on its own" is a second of a room existing that could be listed, and this system has
   * already been burned once by a room outliving its purpose — a redeploy orphaned a SIP
   * room for 998 seconds and put a stranger's phone number on the front page for sixteen
   * minutes (see MAX_ROOM_AGE_SECONDS in active.ts). A warm-up room carries no phone
   * number and could not be listed anyway, but "could not be listed" is a property of two
   * prefix checks in two files, and the cheap way to not depend on them is to not leave
   * the room lying around.
   *
   * A failed delete is reported, not thrown: the room was created, which means the ping
   * did its job, and the timeout will collect it within the second.
   */
  try {
    await api.deleteRoom(name);
  } catch {
    return 'delete-failed';
  }

  return 'pinged';
}

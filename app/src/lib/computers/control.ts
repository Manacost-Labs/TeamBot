import { tryClient } from "@/lib/client";

/** Control-plane requests are short; a hung one must not block the input queue forever. */
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Handing control of a Bot's computer to a person, and back.
 *
 * Plain functions rather than factories, and every one of them fails closed. Nothing here is cached:
 * who holds the wheel is a fact about this second, and a stale copy of it would be worse than no
 * copy — it would show somebody a screen they cannot drive, or let them think they can.
 *
 * The reads answer `null` on failure rather than throwing. A panel that cannot say who is driving
 * should say nothing, not tear down the screen the person is looking at.
 */

export type ControlState = {
  holder: "bot" | "human";
  since: string;
  reason?: string;
  requested: boolean;
  /** What the Bot is waiting for, by name only. Present means show the masked prompt. */
  secretWanted?: string;
};

async function callControl(
  computerId: string,
  path: string,
  method?: string,
): Promise<ControlState | null> {
  try {
    const response = await tryClient(`/api/computers/${computerId}${path}`, {
      ...(method ? { method } : {}),
      timeoutMs: CONTROL_REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) return null;
    return (await response.json()) as ControlState;
  } catch {
    // A stale control panel must stay usable when the computer service is restarting or times out.
    return null;
  }
}

export function readControl(computerId: string) {
  return callControl(computerId, "/control");
}

export function takeControl(computerId: string) {
  return callControl(computerId, "/control/take", "POST");
}

export function releaseControl(computerId: string) {
  return callControl(computerId, "/control/release", "POST");
}

/**
 * Supply a secret synchronously and never echo the value back to the UI.
 *
 * The one call here that reports why it failed, because a person is waiting on the answer and a
 * silent failure would leave them typing into something that is not listening.
 */
export async function supplySecret(
  computerId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/human/secret`,
      {
        method: "POST",
        body: { text },
        timeoutMs: CONTROL_REQUEST_TIMEOUT_MS,
      },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { ok: false, error: body?.error ?? "That could not be entered." };
  } catch {
    return {
      ok: false,
      error: "The assistant's computer could not be reached.",
    };
  }
}

/**
 * Serializes human input requests without blocking the caller; ordering matters for typed secrets.
 */
let inputQueue: Promise<unknown> = Promise.resolve();

/**
 * Send one human input event. Returns immediately; delivery is ordered.
 */
export function sendHumanInput(
  computerId: string,
  kind: "click" | "type" | "key" | "scroll",
  body: Record<string, unknown>,
): void {
  inputQueue = inputQueue
    .then(() =>
      tryClient(`/api/computers/${computerId}/human/${kind}`, {
        method: "POST",
        body,
        timeoutMs: CONTROL_REQUEST_TIMEOUT_MS,
      }),
    )
    // Fire-and-forget: the user can see/retry input failures, while the input queue must keep moving.
    .catch(() => undefined);
}

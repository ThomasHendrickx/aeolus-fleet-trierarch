import { z } from 'zod';

/**
 * Codex's own session log (its rollout file, the transcript its hooks name),
 * read for a refused model: Codex has no hook for a failed turn (#490). A
 * refusal is a turn that completed with Codex's invalid request error naming
 * a model it does not support. Codex documents no format for the log, so the
 * reader is tested on logs captured from real sessions (test/logs), and a
 * recapture on a changed format fails there.
 */

const failedTurnSchema = z.object({
  type: z.literal('event_msg'),
  payload: z.object({ type: z.literal('task_complete'), error: z.object({ message: z.string() }) }),
});

/** The API error a failed turn carries, as JSON text in its message. */
const invalidRequestSchema = z.object({ error: z.object({ type: z.literal('invalid_request_error'), message: z.string() }) });

const NOT_SUPPORTED = /^The '([^']+)' model is not supported/u;

/** A line's JSON; none for a line Codex has not written in full yet. */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The model a failed turn says was not supported; none for a turn that failed for another reason or did not fail. */
function refusedIn(line: string): string | undefined {
  const turn = failedTurnSchema.safeParse(jsonOf(line));
  if (!turn.success) {
    return undefined;
  }
  const request = invalidRequestSchema.safeParse(jsonOf(turn.data.payload.error.message));
  return request.success ? NOT_SUPPORTED.exec(request.data.error.message)?.[1] : undefined;
}

/**
 * The model refused, when the log refuses the one it launched with (or any,
 * when it launched with none, so Codex's own default).
 */
export function codexModelRefusedIn(at: { log: string; model?: string }): string | undefined {
  return at.log
    .split('\n')
    .map(refusedIn)
    .find((id) => id !== undefined && (at.model === undefined || id === at.model));
}

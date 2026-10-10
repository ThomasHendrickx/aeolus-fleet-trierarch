import type { LaunchSeen } from '../core/ports.js';
import { launchSeenWith, type LaunchTexts } from './launch-screen.js';

/**
 * Codex's screen in a session's launch window (#382), as Codex 0.162.1
 * writes it: the one place its texts are matched, tested on screens captured
 * from real sessions (test/screens). "• Working" shows even with no tool
 * call, so it is no activity.
 */
const CODEX_TEXTS: LaunchTexts = {
  // A tool call done: "• Ran echo hi", "• Explored", "• Called aeolus.whoami", "• Edited file.ts".
  activity: /^• (?:Ran \S|Explored$|Called \S|Edited \S)/mu,
  refused: /"type":"invalid_request_error","message":"The '([^']+)' model is not supported/gu,
  screens: [],
};

export function codexLaunchSeen(at: { screen: string; model?: string }): LaunchSeen {
  return launchSeenWith(CODEX_TEXTS, at);
}

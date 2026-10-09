import type { LaunchSeen } from '../core/ports.js';
import { launchSeenWith, type LaunchTexts } from './launch-screen.js';

/**
 * Claude Code's screen in a session's launch window (#382), as Claude Code
 * 2.1.295 writes it: the one place its texts are matched, tested on screens
 * captured from real sessions (test/screens).
 */
const CLAUDE_CODE_TEXTS: LaunchTexts = {
  // A tool call collapsed once done ("Ran 1 shell command", "Read 1 file", "Called aeolus"), under way ("⏺ Reading 1 file…"), or shown whole ("⏺ Bash(echo hi)").
  activity:
    /^ {2}(?:Ran|Read|Wrote|Edited|Updated|Searched for|Listed|Fetched) \d+ |^ {2}Called \S+|^⏺ (?:Running|Reading|Calling|Writing|Editing|Updating|Searching|Listing|Fetching) |^⏺ [A-Za-z][\w-]*\(/mu,
  refused: /There's an issue with the selected model \(([^()\s]+)\)/gu,
};

export function claudeCodeLaunchSeen(at: { screen: string; model?: string }): LaunchSeen {
  return launchSeenWith(CLAUDE_CODE_TEXTS, at);
}

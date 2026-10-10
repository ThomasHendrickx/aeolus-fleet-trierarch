import type { LaunchSeen } from '../core/ports.js';
import { launchSeenWith, type LaunchTexts } from './launch-screen.js';

/**
 * Claude Code's screen in a session's launch window (#382), as Claude Code
 * 2.1.295 writes it: the one place its texts are matched, tested on screens
 * captured from real sessions (test/screens). Its first-run screens (#403)
 * show on a machine where it never ran by hand, and each waits for a key.
 */
const CLAUDE_CODE_TEXTS: LaunchTexts = {
  // A tool call collapsed once done ("Ran 1 shell command", "Read 1 file", "Called aeolus"), under way ("⏺ Reading 1 file…"), or shown whole ("⏺ Bash(echo hi)").
  activity:
    /^ {2}(?:Ran|Read|Wrote|Edited|Updated|Searched for|Listed|Fetched) \d+ |^ {2}Called \S+|^⏺ (?:Running|Reading|Calling|Writing|Editing|Updating|Searching|Listing|Fetching) |^⏺ [A-Za-z][\w-]*\(/mu,
  refused: /There's an issue with the selected model \(([^()\s]+)\)/gu,
  screens: [
    { name: 'theme picker', text: /Choose the text style that looks best with your terminal/u },
    { name: 'login method question', text: /Select login method:/u },
    { name: 'security notes', text: /^ Security notes:/mu },
    { name: 'folder trust question', text: /Is this a project you created or one you trust\?/u },
    { name: 'bypass permissions warning', text: /WARNING: Claude Code running in Bypass Permissions mode/u },
    { name: 'fullscreen renderer offer', text: /Try the new fullscreen renderer\?/u },
  ],
};

export function claudeCodeLaunchSeen(at: { screen: string; model?: string }): LaunchSeen {
  return launchSeenWith(CLAUDE_CODE_TEXTS, at);
}

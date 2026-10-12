import { screenStoppedAt, type LaunchTexts } from './launch-screen.js';

/**
 * Claude Code's screens that stop a session before its hooks run, as Claude
 * Code 2.1.295 writes them: the one place its texts are matched, tested on
 * screens captured from real sessions (test/screens). Its first-run screens
 * (#403) show on a machine where it never ran by hand, and each waits for a
 * key. Activity and a refused model come from the launch marker (#490).
 */
const CLAUDE_CODE_TEXTS: LaunchTexts = {
  screens: [
    { name: 'theme picker', text: /Choose the text style that looks best with your terminal/u },
    { name: 'login method question', text: /Select login method:/u },
    { name: 'security notes', text: /^ Security notes:/mu },
    { name: 'folder trust question', text: /Is this a project you created or one you trust\?/u },
    { name: 'bypass permissions warning', text: /WARNING: Claude Code running in Bypass Permissions mode/u },
    { name: 'fullscreen renderer offer', text: /Try the new fullscreen renderer\?/u },
  ],
};

export function claudeCodeScreenStoppedAt(screen: string): string | undefined {
  return screenStoppedAt(CLAUDE_CODE_TEXTS, screen);
}

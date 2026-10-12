import { screenStoppedAt, type LaunchTexts } from './launch-screen.js';

/**
 * Codex's screen in a session's launch window, as Codex 0.162.1 writes it:
 * the one place its texts are matched, tested on screens captured from real
 * sessions (test/screens). Activity comes from the launch marker and a refused
 * model from Codex's session log (#490).
 * codex-setup answers its folder trust and hooks review screens ahead; they
 * are named here for when one still shows (#602).
 */
const CODEX_TEXTS: LaunchTexts = {
  screens: [
    { name: 'folder trust question', text: /^ {2}Trust this folder\?/mu },
    { name: 'hooks review', text: /^ {2}Hooks need review$/mu },
  ],
};

export function codexScreenStoppedAt(screen: string): string | undefined {
  return screenStoppedAt(CODEX_TEXTS, screen);
}

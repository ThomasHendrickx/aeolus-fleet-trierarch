import { modelRefusedOn, screenStoppedAt, type LaunchTexts } from './launch-screen.js';

/**
 * Codex's screen in a session's launch window, as Codex 0.162.1 writes it:
 * the one place its texts are matched, tested on screens captured from real
 * sessions (test/screens). Codex has no hook for a failed turn, so a refused
 * model is read here; activity comes from the launch marker (#490).
 * codex-setup answers its folder trust and hooks review screens ahead; they
 * are named here for when one still shows (#602).
 */
const CODEX_TEXTS: LaunchTexts = {
  refused: /"type":"invalid_request_error","message":"The '([^']+)' model is not supported/gu,
  screens: [
    { name: 'folder trust question', text: /^ {2}Trust this folder\?/mu },
    { name: 'hooks review', text: /^ {2}Hooks need review$/mu },
  ],
};

/** The Codex version the texts above were checked on, the version its screens in test/screens were captured on (#594). */
export const CODEX_SCREENS_CHECKED_ON = '0.162.1';

export function codexScreenStoppedAt(screen: string): string | undefined {
  return screenStoppedAt(CODEX_TEXTS, screen);
}

export function codexModelRefused(at: { screen: string; model?: string }): string | undefined {
  return modelRefusedOn(CODEX_TEXTS, at);
}

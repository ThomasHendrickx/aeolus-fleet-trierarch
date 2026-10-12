/**
 * The texts a harness writes to its screen in a session's launch window, each
 * adapter its own. Since the launch marker (#490), the screen is read only for
 * what no hook sees: a screen that stops the session before its hooks run.
 */
export interface LaunchTexts {
  /** The harness's screens a session can stop at before its first prompt runs (#403), each by its name and a text only it shows. */
  readonly screens: readonly { readonly name: string; readonly text: RegExp }[];
}

/** The known screen the session stopped at, by its name; none when the screen shows none of them. */
export function screenStoppedAt(texts: LaunchTexts, screen: string): string | undefined {
  return texts.screens.find((each) => each.text.test(screen))?.name;
}

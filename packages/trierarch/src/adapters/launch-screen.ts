/**
 * The texts a harness writes to its screen in a session's launch window, each
 * adapter its own. Since the launch marker (#490), the screen is read only for
 * what no hook sees: a screen that stops the session before its hooks run, and
 * a refusal on a harness with no hook for a failed turn.
 */
export interface LaunchTexts {
  /** The refusal of a model, with the id it refused as its first group; global, so every refusal is seen. None where a hook marks the refusal. */
  readonly refused?: RegExp;
  /** The harness's screens a session can stop at before its first prompt runs (#403), each by its name and a text only it shows. */
  readonly screens: readonly { readonly name: string; readonly text: RegExp }[];
}

/** The known screen the session stopped at, by its name; none when the screen shows none of them. */
export function screenStoppedAt(texts: LaunchTexts, screen: string): string | undefined {
  return texts.screens.find((each) => each.text.test(screen))?.name;
}

/**
 * The model refused, when a refusal names the one it launched with (or any,
 * when it launched with none, so the CLI's own default). A refusal of another
 * id is only text, as when a ship discusses one.
 */
export function modelRefusedOn(texts: LaunchTexts, at: { screen: string; model?: string }): string | undefined {
  if (texts.refused === undefined) {
    return undefined;
  }
  for (const [, id] of at.screen.matchAll(texts.refused)) {
    if (id !== undefined && (at.model === undefined || id === at.model)) {
      return id;
    }
  }
  return undefined;
}

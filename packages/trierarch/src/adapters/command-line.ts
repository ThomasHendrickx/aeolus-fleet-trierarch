/**
 * A harness's command line in parts, each marked by where its words come
 * from: the configuration's flags, or what the adapter adds itself. The
 * program and the prompt carry no source. Launch runs the words; config
 * check prints the parts, so the operator sees what will launch and why.
 */
export interface CommandPart {
  readonly words: readonly string[];
  readonly source?: 'configuration' | 'adapter';
  /** When the words apply, where config check cannot know it: the launch knows and runs them or not. */
  readonly when?: string;
}

export function wordsOf(parts: readonly CommandPart[]): string[] {
  return parts.flatMap((part) => part.words);
}

/** One line: each part's words, a word with a space in quotes and its line breaks as \n, and each flag part followed by its source and when it applies. */
export function describeCommandLine(parts: readonly CommandPart[]): string {
  return parts
    .map((part) => {
      const words = part.words.map((word) => (word.includes(' ') ? `"${word.replaceAll('\n', '\\n')}"` : word)).join(' ');
      if (part.source === undefined) {
        return words;
      }
      return part.when === undefined ? `${words} (${part.source})` : `${words} (${part.source}, when ${part.when})`;
    })
    .join(' ');
}

/** The parts with words in them: a configuration with no flags adds no empty part. */
export function partsWithWords(parts: readonly CommandPart[]): CommandPart[] {
  return parts.filter((part) => part.words.length > 0);
}

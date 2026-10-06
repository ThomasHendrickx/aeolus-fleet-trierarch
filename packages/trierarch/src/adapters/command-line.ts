/**
 * A harness's command line in parts, each marked by where its words come
 * from: the configuration's flags, or what the adapter adds itself. The
 * program and the prompt carry no source. Launch runs the words; config
 * check prints the parts, so the operator sees what will launch and why.
 */
export interface CommandPart {
  readonly words: readonly string[];
  readonly source?: 'configuration' | 'adapter';
}

export function wordsOf(parts: readonly CommandPart[]): string[] {
  return parts.flatMap((part) => part.words);
}

/** One line: each part's words, a word with a space in quotes, and each flag part followed by its source. */
export function describeCommandLine(parts: readonly CommandPart[]): string {
  return parts
    .map((part) => {
      const words = part.words.map((word) => (word.includes(' ') ? `"${word}"` : word)).join(' ');
      return part.source === undefined ? words : `${words} (${part.source})`;
    })
    .join(' ');
}

/** The parts with words in them: a configuration with no flags adds no empty part. */
export function partsWithWords(parts: readonly CommandPart[]): CommandPart[] {
  return parts.filter((part) => part.words.length > 0);
}

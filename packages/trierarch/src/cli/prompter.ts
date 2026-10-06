import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/**
 * How init asks the operator: a line of text, a secret never shown as it is
 * typed, yes or no. Node's readline, no prompt library: the questions are
 * few and plain.
 */
export interface Prompter {
  text(question: string, options?: { default?: string }): Promise<string>;
  /** Asks without showing what is typed, so a secret stays out of the screen, the scrollback and any transcript. */
  secret(question: string): Promise<string>;
  confirm(question: string, options: { isDefault: boolean }): Promise<boolean>;
  say(message: string): void;
}

export interface TerminalPrompter extends Prompter {
  close(): void;
}

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

export function createTerminalPrompter(at: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream & { isTTY?: boolean } }): TerminalPrompter {
  const { input, output } = at;
  // What readline echoes goes through here, so a secret's keys can be kept off the screen.
  let isMuted = false;
  const echo = new Writable({
    writev(chunks, done) {
      if (!isMuted) {
        for (const { chunk } of chunks) {
          if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
            output.write(chunk);
          }
        }
      }
      done();
    },
  });
  const lines = createInterface({ input, output: echo, terminal: output.isTTY === true });
  const waiting: string[] = [];
  const readers: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  let hasEnded = false;
  lines.on('line', (line) => {
    const reader = readers.shift();
    if (reader === undefined) {
      waiting.push(line);
    } else {
      reader.resolve(line);
    }
  });
  lines.on('close', () => {
    hasEnded = true;
    for (const reader of readers.splice(0)) {
      reader.reject(new Error('The input ended'));
    }
  });

  const ask = async (question: string): Promise<string> => {
    output.write(question);
    const line = waiting.shift();
    if (line !== undefined) {
      return line;
    }
    try {
      if (hasEnded) {
        throw new Error('The input ended');
      }
      return await new Promise<string>((resolve, reject) => {
        readers.push({ resolve, reject });
      });
    } catch {
      throw new Error(`The input ended before an answer to: ${question.trim()}`);
    }
  };

  const prompter: TerminalPrompter = {
    text: async (question, options = {}) => {
      const answer = (await ask(`${question} ${options.default === undefined ? '' : `(${options.default}) `}`)).trim();
      return answer === '' ? (options.default ?? '') : answer;
    },
    secret: async (question) => {
      output.write(`${question} `);
      isMuted = true;
      try {
        return (await ask('')).trim();
      } finally {
        isMuted = false;
        output.write('\n');
      }
    },
    confirm: async (question, { isDefault }) => {
      for (;;) {
        const answer = (await ask(`${question} ${isDefault ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
        if (answer === '') {
          return isDefault;
        }
        if (YES.has(answer) || NO.has(answer)) {
          return YES.has(answer);
        }
        prompter.say('Answer y or n.');
      }
    },
    say: (message) => {
      output.write(`${message}\n`);
    },
    close: () => {
      lines.close();
    },
  };
  return prompter;
}

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import { PLAIN, type Style } from '../adapters/style.js';

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
  /** Starts a step of the flow: its title is shown before the step's first question, and not at all for a step that asks nothing. */
  step(title: string): void;
}

export interface TerminalPrompter extends Prompter {
  close(): void;
}

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

export function createTerminalPrompter(at: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream & { isTTY?: boolean }; style?: Style }): TerminalPrompter {
  const { input, output } = at;
  const style = at.style ?? PLAIN;
  // The title of the step whose first question is still to come.
  let pendingStep: string | undefined;
  const showStep = (): void => {
    if (pendingStep !== undefined) {
      output.write(`\n${style.tone('strong', pendingStep)}\n`);
      pendingStep = undefined;
    }
  };
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
    showStep();
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
      const answer = (await ask(`${question} ${options.default === undefined ? '' : `${style.tone('quiet', `(${options.default})`)} `}`)).trim();
      return answer === '' ? (options.default ?? '') : answer;
    },
    secret: async (question) => {
      showStep();
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
        const answer = (await ask(`${question} ${style.tone('quiet', isDefault ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
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
      output.write(`${style.tone('busy', message)}\n`);
    },
    step: (title) => {
      pendingStep = title;
    },
    close: () => {
      lines.close();
    },
  };
  return prompter;
}

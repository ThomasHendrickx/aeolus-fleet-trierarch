import { describe, expect, it } from 'vitest';

import { HOLD_AFTER_EXIT_MS, heldCommand } from './held-command.js';
import { runCommand } from './run-command.js';

describe('a session command held after it ends (#888)', () => {
  it("ends with the command's own exit status", async () => {
    const [program = '', ...args] = heldCommand(['sh', '-c', 'exit 3']);

    await expect(runCommand(program, { args })).resolves.toMatchObject({ status: 3 });
  });

  it('keeps its terminal a moment after the command ended, so tmux reads the last output before the pane dies', async () => {
    const [program = '', ...args] = heldCommand(['true']);
    const startedAt = Date.now();

    await runCommand(program, { args });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(HOLD_AFTER_EXIT_MS);
  });
});

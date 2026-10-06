import type { Service } from '../adapters/service.js';
import type { Uninstall } from '../core/uninstall.js';

/**
 * `aeolus-trierarch uninstall` (docs/trierarch.md, lifecycle row 10): removes
 * the service first, so nothing starts a session again, then stops every
 * session and lists the worktrees it leaves. It deletes nothing: not a
 * worktree, and not its own files.
 */

export interface UninstallReport {
  /** The service's file, removed. */
  readonly service: string;
  readonly worktrees: readonly string[];
  readonly said: readonly string[];
}

export async function uninstallTrierarch(at: { service: Pick<Service, 'uninstall' | 'status'>; uninstall: Uninstall; home: string }): Promise<UninstallReport> {
  const { file } = await at.service.status();
  await at.service.uninstall();
  const { worktrees } = await at.uninstall();
  return {
    service: file,
    worktrees,
    said: [
      `Removed the service (${file}): the trierarch no longer runs, and stopped every session it ran.`,
      worktrees.length === 0 ? 'It leaves no worktree.' : `It deleted no worktree. Remove these by hand once you no longer need them:\n${worktrees.map((path) => `  ${path}`).join('\n')}`,
      `Its configuration, crew token, state and logs stay in ${at.home}. Its ship, and the ships it crewed, stay crewed in the fleet: release them in the console.`,
      'aeolus-trierarch itself stays installed: npm uninstall --global @aeolus-fleet/trierarch removes it.',
    ],
  };
}

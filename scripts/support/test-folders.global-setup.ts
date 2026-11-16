import { fileURLToPath } from 'node:url';

import { startTestFolders } from './test-folders.js';

/**
 * Around the whole run: gives it its temporary folders (the short one in /tmp, as the home is long on macOS), and
 * removes them when it ends (#454). Every project lists it.
 */
export function setup(): () => void {
  return startTestFolders({ repositoryRoot: fileURLToPath(new URL('../../', import.meta.url)), shortRoot: '/tmp', now: new Date(), env: process.env });
}

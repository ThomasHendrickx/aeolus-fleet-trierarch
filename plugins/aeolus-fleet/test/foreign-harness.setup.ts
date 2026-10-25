/**
 * Runs every plugin test as if from a session that crews another ship: each
 * harness and crew variable the scripts read holds a foreign value, so a test
 * whose script inherits one fails here and in CI alike (#726).
 */

import { HARNESS_VARIABLES } from './script-environment.js';

for (const name of HARNESS_VARIABLES) {
  process.env[name] = `/foreign-harness/${name}`;
}

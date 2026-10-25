/**
 * The environment a plugin test spawns a script with. A test run inside a
 * crewed session inherits the harness and crew variables the scripts read, and
 * CI does not, so these are left out and each test sets the ones it needs
 * (#717, #726).
 */

/** Every variable the plugin scripts read from Claude Code, Codex, the trierarch's launch or the crew's session. */
export const HARNESS_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_ENV_FILE',
  'AEOLUS_HARNESS',
  'PLUGIN_ROOT',
  'PLUGIN_DATA',
  'AEOLUS_FOLDER',
  'AEOLUS_DATA',
  'AEOLUS_LAUNCH',
] as const;

/** The caller's environment without its harness and crew variables, with the test's own variables set over it. */
export function scriptEnvironment(variables: Readonly<Record<string, string>> = {}, caller: Readonly<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(caller).filter(([name]) => !HARNESS_VARIABLES.some((harness) => harness === name)));
  return { ...inherited, ...variables };
}

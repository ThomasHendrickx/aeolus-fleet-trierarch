/**
 * The environment a plugin test spawns a script with. A test run inside
 * Claude Code inherits its harness variables and CI does not, so these are
 * left out and each test sets the ones it needs (#717).
 */

const HARNESS_VARIABLES = ['CLAUDECODE', 'CLAUDE_PLUGIN_ROOT', 'AEOLUS_HARNESS', 'PLUGIN_ROOT'] as const;

/** The caller's environment without its harness variables, with the test's own variables set over it. */
export function scriptEnvironment(variables: Readonly<Record<string, string>> = {}, caller: Readonly<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(caller).filter(([name]) => !HARNESS_VARIABLES.some((harness) => harness === name)));
  return { ...inherited, ...variables };
}

import type { MACHINE_ARCH, MACHINE_OS, TrierarchReportDetails } from '@aeolus-fleet/common';

/** The machine as a trierarch reports it: its os and arch, each when it is a known one. */
export type Machine = NonNullable<TrierarchReportDetails['machine']>;

/** Node's names for the platforms the trierarch plugin labels, by the os label's values. */
const OS_OF: Readonly<Record<string, (typeof MACHINE_OS)[number]>> = { darwin: 'macos', linux: 'linux', win32: 'windows' };

/** Node's names for the architectures the trierarch plugin labels, by the arch label's values. */
const ARCH_OF: Readonly<Record<string, (typeof MACHINE_ARCH)[number]>> = { arm64: 'arm64', x64: 'amd64' };

/**
 * Policy: the machine a trierarch runs on, for the trierarch plugin to label
 * its ship by (#102; docs/trierarch.md, "Machine labels"), from Node's
 * platform and arch. One outside the known ones is left out.
 */
export function machineOf(node: { platform: string; arch: string }): Machine {
  const os = OS_OF[node.platform];
  const arch = ARCH_OF[node.arch];
  return { ...(os === undefined ? {} : { os }), ...(arch === undefined ? {} : { arch }) };
}

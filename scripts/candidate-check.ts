/**
 * Checks a passed candidate run of the released commit and the versioned plugin
 * archive's integrity before the release changes anything.
 * Usage: gh run view <run id> --json workflowName,conclusion,headSha
 *   | node scripts/candidate-check.ts <version> <sha> <candidate folder>
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';


const candidateRunSchema = z.object({ workflowName: z.string(), conclusion: z.string(), headSha: z.string() });
const packedTarballSchema = z.object({ name: z.string(), version: z.string(), filename: z.string(), integrity: z.string() });

export type CandidateRun = z.infer<typeof candidateRunSchema>;
export type PackedTarball = z.infer<typeof packedTarballSchema>;

/** Why the candidate may not be published, or undefined when it may. downloaded maps each file's name to the integrity of its bytes. */
export function candidateRefusal(check: {
  version: string;
  sha: string;
  run: CandidateRun;
  manifest: readonly PackedTarball[];
  downloaded: Readonly<Record<string, string>>;
}): string | undefined {
  if (check.run.workflowName !== 'Candidate') {
    return `The run is a ${check.run.workflowName} run, not a Candidate run`;
  }
  if (check.run.conclusion !== 'success') {
    return `The Candidate run did not pass (${check.run.conclusion})`;
  }
  if (check.run.headSha !== check.sha) {
    return `The candidate is of ${check.run.headSha}, not of the released commit ${check.sha}`;
  }
  for (const name of ['aeolus-fleet-plugin']) {
    const tarball = check.manifest.find((packed) => packed.name === name);
    if (tarball === undefined) {
      return `The candidate has no ${name}`;
    }
    if (tarball.version !== check.version) {
      return `The candidate holds ${name} ${tarball.version}, not ${check.version}`;
    }
    const filename = `aeolus-fleet-plugin-${check.version}.tgz`;
    if (tarball.filename !== filename) {
      return `The candidate names ${tarball.filename}, not ${filename}`;
    }
    const downloaded = check.downloaded[tarball.filename];
    if (downloaded === undefined) {
      return `The download has no ${tarball.filename}`;
    }
    if (downloaded !== tarball.integrity) {
      return `${tarball.filename} is not the tarball the candidate packed: its integrity differs`;
    }
  }
  return undefined;
}

/** The candidate integrity of a file: sha512, base64. */
function integrityOf(path: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
}

if (import.meta.main) {
  try {
    const [version = '', sha = '', folder = ''] = process.argv.slice(2);
    if (version === '' || sha === '' || folder === '') {
      throw new Error("Usage: node scripts/candidate-check.ts <version> <sha> <candidate folder>, with the run's JSON on stdin");
    }
    const run = candidateRunSchema.parse(JSON.parse(readFileSync(0, 'utf8')));
    const manifest = z.array(packedTarballSchema).parse(JSON.parse(readFileSync(join(folder, 'integrity.json'), 'utf8')));
    const downloaded = Object.fromEntries(
      manifest.filter(({ filename }) => existsSync(join(folder, filename))).map(({ filename }) => [filename, integrityOf(join(folder, filename))]),
    );
    const refusal = candidateRefusal({ version, sha, run, manifest, downloaded });
    if (refusal !== undefined) {
      console.error(`::error::${refusal}`);
      process.exit(1);
    }
    console.log(`The candidate holds the trierarch at ${version}, packed from ${sha}, byte for byte`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

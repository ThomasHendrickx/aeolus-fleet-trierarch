/**
 * The Homebrew formula of a release: the template in homebrew/aeolus-trierarch.rb with the release's version and,
 * for each system and chip, the URL of its binary on the GitHub Release and its checksum from SHA256SUMS. Used by
 * the release workflow, which pushes the result to the tap.
 *
 * Usage: node scripts/homebrew-formula.ts <version> <owner/repository> <SHA256SUMS file> < homebrew/aeolus-trierarch.rb
 */
import { readFileSync } from 'node:fs';

/** The binaries a release carries, by the placeholder prefix the template uses for each. */
const BINARIES = [
  { prefix: 'DARWIN_ARM64', name: 'aeolus-trierarch-darwin-arm64' },
  { prefix: 'DARWIN_AMD64', name: 'aeolus-trierarch-darwin-amd64' },
  { prefix: 'LINUX_ARM64', name: 'aeolus-trierarch-linux-arm64' },
  { prefix: 'LINUX_AMD64', name: 'aeolus-trierarch-linux-amd64' },
] as const;

/** The checksum of a file in `sha256sum` output, or undefined when it holds none. */
function checksumOf(sums: string, name: string): string | undefined {
  return sums
    .split('\n')
    .map((line) => /^([0-9a-f]{64}) {2}(.+)$/.exec(line))
    .find((match) => match?.[2] === name)?.[1];
}

export function homebrewFormula(release: { template: string; version: string; repository: string; sums: string }): string {
  const base = `https://github.com/${release.repository}/releases/download/v${release.version}`;
  const values = new Map<string, string>([['VERSION', release.version]]);
  for (const { prefix, name } of BINARIES) {
    const checksum = checksumOf(release.sums, name);
    if (checksum === undefined) {
      throw new Error(`SHA256SUMS has no ${name}`);
    }
    values.set(`${prefix}_URL`, `${base}/${name}`);
    values.set(`${prefix}_SHA256`, checksum);
  }
  const formula = release.template.replace(/@([A-Z0-9_]+)@/g, (placeholder, key: string) => values.get(key) ?? placeholder);
  const unfilled = /@[A-Z0-9_]+@/.exec(formula);
  if (unfilled !== null) {
    throw new Error(`The template keeps the placeholder ${unfilled[0]}`);
  }
  return formula;
}

if (import.meta.main) {
  try {
    const [version, repository, sumsFile] = process.argv.slice(2);
    if (version === undefined || repository === undefined || sumsFile === undefined) {
      throw new Error('Usage: node scripts/homebrew-formula.ts <version> <owner/repository> <SHA256SUMS file>, with the template on stdin');
    }
    process.stdout.write(homebrewFormula({ template: readFileSync(0, 'utf8'), version, repository, sums: readFileSync(sumsFile, 'utf8') }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

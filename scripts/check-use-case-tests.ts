/**
 * CI check: every use case in the trierarch's src/core has a test file
 * beside it (CLAUDE.md, "Quality"). A use-case file is a file in src/core that
 * declares an exported factory named create<Name>, like `createConnect`
 * (domain-modelling skill); its test is `<file name>.test.ts` in the same
 * folder.
 *
 * Usage: node scripts/check-use-case-tests.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import { repositoryRoot, trackedFiles } from './support/git.ts';
import { report } from './support/report.ts';

export const CORE_FOLDER = 'packages/trierarch/src/core/';

const FACTORY_NAME = /^create[A-Z]/;

/** The names of the use-case factories a source file declares and exports. */
export function useCaseFactories(source: string): string[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest);
  return file.statements.filter(isExported).flatMap(declaredNames).filter((name) => FACTORY_NAME.test(name));
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name ? [statement.name.text] : [];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  return [];
}

export function useCaseTestProblems(repository: string): string[] {
  const files = trackedFiles(repository);
  const tracked = new Set(files);

  return files
    .filter((file) => file.startsWith(CORE_FOLDER) && file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .flatMap((file) => {
      const factories = useCaseFactories(readFileSync(join(repository, file), 'utf8'));
      const test = file.replace(/\.ts$/, '.test.ts');
      return factories.length > 0 && !tracked.has(test)
        ? [`${file} is a use case (${factories.join(', ')}) without ${test}`]
        : [];
    });
}

if (import.meta.main) {
  report({ name: 'Use cases have tests', problems: useCaseTestProblems(repositoryRoot) });
}

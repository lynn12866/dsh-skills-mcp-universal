import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

// Harness loads a classic script. Type-only imports make tsc emit an empty
// module marker, which must be removed without allowing runtime ES imports.
const file = new URL('../client.js', import.meta.url);
const source = await readFile(file, 'utf8');
const ast = ts.createSourceFile('client.js', source, ts.ScriptTarget.ES2022, true);
let classic = source;
for (const statement of [...ast.statements].reverse()) {
  if (
    ts.isExportDeclaration(statement) &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause) &&
    !statement.exportClause.elements.length
  ) {
    classic = classic.slice(0, statement.getStart(ast)) + classic.slice(statement.end);
  } else if (
    ts.isImportDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isExportAssignment(statement)
  ) {
    throw new Error('The browser entry must use Harness modules through its factory.');
  }
}
await writeFile(file, classic);

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { test } from "vitest";

// package.json exports "./src/*", so every src module is importable and must
// ship a declaration whose value exports match the runtime module.
const srcDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const modules = readdirSync(srcDirectory).filter(name => name.endsWith(".js")).sort();

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === kind);

/** Names of the runtime values a declaration file exports (types are excluded). */
function declaredValueExports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const localValues = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) localValues.add(declaration.name.text);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      localValues.add(statement.name.text);
    } else if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
      const { name, namedBindings } = statement.importClause;
      if (name) localValues.add(name.text);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) if (!element.isTypeOnly) localValues.add(element.name.text);
      }
    }
  }

  const exported = new Set<string>();
  for (const statement of source.statements) {
    const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isVariableStatement(statement) && isExported) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && isExported) {
      if (isDefault) exported.add("default");
      else if (statement.name) exported.add(statement.name.text);
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      // `export default Foo` is a value unless Foo is only an interface/type.
      if (!ts.isIdentifier(statement.expression) || localValues.has(statement.expression.text)) exported.add("default");
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (!clause) throw new Error(`${file}: \`export * from\` is not supported by this test; list the names explicitly`);
      if (ts.isNamespaceExport(clause)) {
        exported.add(clause.name.text);
      } else {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          // A local `export { Foo }` of an interface/type alias is not a value.
          if (!statement.moduleSpecifier && !localValues.has((element.propertyName ?? element.name).text)) continue;
          exported.add(element.name.text);
        }
      }
    }
  }
  return [...exported].sort();
}

test.each(modules)("src/%s ships a declaration matching its runtime exports", async name => {
  const dtsPath = join(srcDirectory, name.replace(/\.js$/, ".d.ts"));
  assert.ok(existsSync(dtsPath), `${name} has no sibling ${name.replace(/\.js$/, ".d.ts")}`);
  const runtime = Object.keys(await import(pathToFileURL(join(srcDirectory, name)).href)).sort();
  const declared = declaredValueExports(dtsPath);
  const undeclared = runtime.filter(exportName => !declared.includes(exportName));
  const phantom = declared.filter(exportName => !runtime.includes(exportName));
  assert.ok(
    undeclared.length === 0 && phantom.length === 0,
    `${name}: runtime exports missing from the .d.ts: [${undeclared.join(", ")}]; .d.ts values missing at runtime: [${phantom.join(", ")}]`,
  );
});

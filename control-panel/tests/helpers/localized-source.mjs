import ts from 'typescript';
import {readFileSync} from 'node:fs';
const catalogue = JSON.parse(readFileSync(new URL('../../messages/en.json', import.meta.url)));
const english = catalogue.interface;

/**
 * Layout/source-contract tests compare the English projection of catalogue calls.
 * Only real literal keys found in the source are expanded. This is not a render
 * test; localized-consent and rendered-page tests cover actual translation.
 */
export function englishInterfaceSource(source) {
  const ast = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const namespaces = new Map([['translateInterface', 'interface']]);
  function findNamespaces(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isCallExpression(node.initializer) && /^(useTranslations|useInterfaceTranslations)$/.test(node.initializer.expression.getText(ast))
      && ts.isStringLiteral(node.initializer.arguments[0])) namespaces.set(node.name.text, node.initializer.arguments[0].text);
    ts.forEachChild(node, findNamespaces);
  }
  findNamespaces(ast);
  function visit(node) {
    if (ts.isCallExpression(node) && namespaces.has(node.expression.getText(ast))
      && ts.isStringLiteral(node.arguments[0]) && typeof catalogue[namespaces.get(node.expression.getText(ast))]?.[node.arguments[0].text] === 'string') {
      let text = catalogue[namespaces.get(node.expression.getText(ast))][node.arguments[0].text];
      const values = node.arguments[1];
      if (values && ts.isObjectLiteralExpression(values)) {
        for (const entry of values.properties) {
          if (ts.isPropertyAssignment(entry)) text = text.replaceAll(`{${entry.name.getText(ast)}}`, `{${entry.initializer.getText(ast)}}`);
        }
      }
      const parent = node.parent;
      if (ts.isJsxExpression(parent) && parent.expression === node) {
        edits.push({start: parent.getStart(ast), end: parent.end,
          text: ts.isJsxAttribute(parent.parent) ? JSON.stringify(text) : text});
      } else edits.push({start: node.getStart(ast), end: node.end, text: JSON.stringify(text)});
      return;
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'labelKey' && ts.isStringLiteral(node.initializer) && english[node.initializer.text]) {
      edits.push({start:node.getStart(ast), end:node.end, text:'label: '+JSON.stringify(english[node.initializer.text])}); return;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const edit of edits.sort((a,b) => b.start - a.start)) source = source.slice(0,edit.start) + edit.text + source.slice(edit.end);
  return source;
}

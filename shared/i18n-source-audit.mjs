import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const attributes = new Set(["title", "placeholder", "aria-label", "alt", "label", "description", "desc",
  "confirmLabel", "cancelLabel", "k", "d", "heading", "emptyMessage", "subtitle", "buttonLabel", "hint", "errorMessage"]);
const displayModules = new Set(["ai-navigation.ts", "creative/data.ts", "lib/design.ts", "lib/icon-styles.ts"]);

/** The same source boundaries apply to CP and UI, including their shared editor. */
export function collectSourceLiterals(root, ts) {
  function files(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      if (["node_modules", ".git", "messages"].includes(entry.name)) return [];
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return files(path);
      return entry.name.endsWith(".tsx") || [...displayModules].some(name => path.endsWith("/" + name)) ? [path] : [];
    });
  }
  function visible(node) {
    const parent = node.parent;
    if (ts.isJsxAttribute(parent)) return attributes.has(parent.name.text);
    if (ts.isJsxExpression(parent)) return !ts.isJsxAttribute(parent.parent) || attributes.has(parent.parent.name.text);
    if (ts.isConditionalExpression(parent) && node !== parent.condition) return visible(parent);
    if (ts.isBinaryExpression(parent) && ["||", "??"].includes(parent.operatorToken.getText()) && parent.right === node) return visible(parent);
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && /^set(Error|Status|Message|Success|Notice|Connection)$/.test(parent.expression.text)) return true;
    if (ts.isPropertyAssignment(parent) && attributes.has(parent.name.getText().replaceAll('"', "").replaceAll("'", ""))) return true;
    return false;
  }
  const found = new Map();
  for (const file of [...files(resolve(root, "src")), ...files(resolve(root, "../packages/branding"))]) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const directive = source.statements.findIndex(statement => ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) && statement.expression.text === "use client");
    if (directive > 0) throw new Error(`Client directive must precede imports: ${relative(root, file)}`);
    function visit(node) {
      let text;
      if (ts.isJsxText(node)) text = node.text.replace(/\s+/g, " ").trim();
      else if (ts.isStringLiteral(node) && visible(node)) text = node.text;
      if (text && /[A-Za-z]{2}/.test(text)) {
        const id = JSON.stringify([relative(root, file), text]);
        found.set(id, (found.get(id) || 0) + 1);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return found;
}

// Every message key the source uses must exist in every catalogue (YE-163). A key that no catalogue has renders as
// its raw id ("interface.m1b0ec1954eec"), and next-intl only logs that at run time, so the build checks it.
//
// Two ways a key is found:
// 1. Calls on a translator: a variable bound to next-intl's useTranslations / getTranslations / createTranslator
//    (under any local name), called as t("key"), t.rich, t.markup or t.raw. The binding is resolved through the
//    enclosing scopes and its namespace is applied. Literal keys and both branches of a `?:` are checked; any other
//    argument is dynamic and only counted.
// 2. Interface key literals: any string shaped like a generated interface key (m + 12 hex digits) must exist in the
//    `interface` namespace. This also covers keys kept in label maps and translators passed on as arguments, which
//    the first rule cannot follow.
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const translatorModules = new Set(["next-intl", "next-intl/server"]);
const translatorFactories = new Set(["useTranslations", "getTranslations", "createTranslator"]);
const translatorMethods = new Set(["rich", "markup", "raw"]);
export const interfaceKeyPattern = /^m[0-9a-f]{12}$/;

/** Flatten a catalogue tree into { "namespace.key": text }. */
export function flattenMessages(tree, prefix = "") {
  return Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") return [[name, value]];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid message ${name}`);
    return Object.entries(flattenMessages(value, name));
  }));
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", ".git", ".next"].includes(entry.name)) return [];
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|mts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/**
 * Check the source under `sourceDirs` against `catalogues` ({ <locale>: <message tree> }).
 * Returns { files, keys, dynamic: [{ file, line, text }], missing: [{ file, line, key, locales }] }.
 */
export function checkMessageKeys({ root, ts, sourceDirs, catalogues }) {
  const flat = Object.fromEntries(Object.entries(catalogues).map(([code, tree]) => [code, flattenMessages(tree)]));
  const missing = [];
  const dynamic = [];
  let keys = 0;
  const files = sourceDirs.flatMap(dir => sourceFiles(dir));

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const where = node => ({ file: relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    const report = (node, key, group = false) => {
      keys++;
      const has = code => key in flat[code] || (group && Object.keys(flat[code]).some(name => name.startsWith(`${key}.`)));
      const locales = Object.keys(flat).filter(code => !has(code));
      if (locales.length) missing.push({ ...where(node), key, locales });
    };

    // Local names of the translator factories imported from next-intl.
    const factories = new Set();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !translatorModules.has(statement.moduleSpecifier.text)) continue;
      const named = statement.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) continue;
      for (const element of named.elements) {
        if (translatorFactories.has((element.propertyName ?? element.name).text)) factories.add(element.name.text);
      }
    }

    const unwrap = node => {
      while (node && (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
        ts.isNonNullExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)))) node = node.expression;
      return node;
    };
    // The namespace a factory call binds: "" for none, a string, or null when it is not a literal.
    const namespaceOf = call => {
      const [first] = call.arguments;
      if (!first) return "";
      if (ts.isStringLiteralLike(first)) return first.text;
      if (ts.isObjectLiteralExpression(first)) {
        // A spread or a shorthand `namespace` may carry any namespace: not a literal.
        if (first.properties.some(p => ts.isSpreadAssignment(p))) return null;
        const property = first.properties.find(p => p.name?.getText(source) === "namespace");
        if (!property) return "";
        return ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : null;
      }
      return null;
    };
    const isFactoryCall = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && factories.has(node.expression.text);
    const isScope = node => ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) ||
      ts.isDefaultClause(node) || ts.isFunctionLike(node) || ts.isForStatement(node) || ts.isForOfStatement(node) ||
      ts.isForInStatement(node) || ts.isCatchClause(node);

    // scope node -> Map(name -> binding). A binding is null (not a translator), { namespace } (a translator; namespace
    // null when it is not known), or { prop: { component, prop } } (a translator passed to a component as a prop).
    const scopes = new Map();
    const scopeOf = node => {
      let scope = node.parent;
      while (scope && !isScope(scope)) scope = scope.parent;
      return scope;
    };
    const set = (scope, name, binding, override) => {
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      if (override || !scopes.get(scope).has(name)) scopes.get(scope).set(name, binding);
    };
    // Every name a binding pattern declares hides an outer translator of the same name.
    const bindPattern = (name, scope, override) => {
      if (ts.isIdentifier(name)) set(scope, name.text, null, override);
      else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindPattern(element.name, scope, override);
    };
    const translatorType = type => Boolean(type) &&
      [...new Set([...factories, ...translatorFactories])].some(name => new RegExp(`typeof\\s+${name}\\b`).test(type.getText(source)));
    // The component a function is: `function Name(…)` or `const Name = (…) =>`, unless exported (callers elsewhere).
    const componentName = fn => {
      const exported = node => node?.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isFunctionDeclaration(fn) && fn.name) return exported(fn) ? null : fn.name.text;
      const declaration = fn.parent;
      if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        return exported(declaration.parent?.parent) ? null : declaration.name.text;
      }
      return null;
    };
    const collect = node => {
      if (ts.isVariableDeclaration(node)) {
        const init = unwrap(node.initializer);
        if (ts.isIdentifier(node.name)) set(scopeOf(node), node.name.text, init && isFactoryCall(init) ? { namespace: namespaceOf(init) } : null);
        else bindPattern(node.name, scopeOf(node));
      } else if (ts.isParameter(node)) {
        // A parameter belongs to its function and shadows any outer name.
        const fn = node.parent;
        if (ts.isIdentifier(node.name)) {
          set(fn, node.name.text, translatorType(node.type) ? { namespace: null } : null, true);
        } else if (ts.isObjectBindingPattern(node.name)) {
          // ({ t }: { t: ReturnType<typeof useTranslations> }): a translator passed as a prop.
          const members = node.type && ts.isTypeLiteralNode(node.type) ? node.type.members : [];
          const component = componentName(fn);
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) { bindPattern(element.name, fn, true); continue; }
            const prop = (element.propertyName ?? element.name).getText(source);
            const member = members.find(m => ts.isPropertySignature(m) && m.name.getText(source) === prop);
            const binding = member && translatorType(member.type) ? (component ? { prop: { component, prop } } : { namespace: null }) : null;
            set(fn, element.name.text, binding, true);
          }
        } else {
          bindPattern(node.name, fn, true);
        }
      } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        set(scopeOf(node), node.name.text, null);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    const lookup = (identifier) => {
      for (let scope = identifier.parent; scope; scope = scope.parent) {
        const names = scopes.get(scope);
        if (names?.has(identifier.text)) return names.get(identifier.text);
      }
      return null;
    };
    // A translator prop's namespace: the one every `<Component prop={translator} />` in this file passes, else null.
    const propNamespaces = new Map();
    const propNamespace = ({ component, prop }) => {
      const id = `${component}\0${prop}`;
      if (propNamespaces.has(id)) return propNamespaces.get(id);
      propNamespaces.set(id, null); // a component passing its own prop on resolves to unknown, not a loop
      const passed = [];
      const find = node => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === component) {
          const attributes = node.attributes.properties;
          const attribute = attributes.find(a => ts.isJsxAttribute(a) && a.name.getText(source) === prop);
          const value = attribute?.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
          // A spread may pass the prop too, so it is unknown.
          passed.push(value && ts.isIdentifier(value) && !attributes.some(a => ts.isJsxSpreadAttribute(a)) ? resolveTranslator(value) : null);
        }
        ts.forEachChild(node, find);
      };
      find(source);
      const namespaces = new Set(passed.map(binding => binding?.namespace ?? null));
      const namespace = passed.length && namespaces.size === 1 ? [...namespaces][0] : null;
      propNamespaces.set(id, namespace);
      return namespace;
    };
    const resolveTranslator = (identifier) => {
      const binding = lookup(identifier);
      return binding?.prop ? { namespace: propNamespace(binding.prop) } : binding;
    };
    // The literal keys an argument can take, or null when it is dynamic.
    const literalKeys = node => {
      node = unwrap(node);
      if (!node) return null;
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isConditionalExpression(node)) {
        const a = literalKeys(node.whenTrue), b = literalKeys(node.whenFalse);
        return a && b ? [...a, ...b] : null;
      }
      return null;
    };

    const checkedLiterals = new Set();
    const visit = node => {
      if (ts.isCallExpression(node)) {
        let callee = node.expression, translator = null, method = null;
        if (ts.isPropertyAccessExpression(callee) && translatorMethods.has(callee.name.text)) { method = callee.name.text; callee = callee.expression; }
        if (ts.isIdentifier(callee)) translator = resolveTranslator(callee);
        else if (isFactoryCall(callee)) translator = { namespace: namespaceOf(callee) };
        if (translator && node.arguments.length) {
          const found = literalKeys(node.arguments[0]);
          const arg = unwrap(node.arguments[0]);
          if (translator.namespace === null || !found) {
            dynamic.push({ ...where(node), text: node.getText(source).slice(0, 120) });
            // t(`channel.names.${channel}`): at least one message must exist under the literal head.
            if (translator.namespace !== null && ts.isTemplateExpression(arg) && arg.head.text.endsWith(".")) {
              const prefix = (translator.namespace ? `${translator.namespace}.` : "") + arg.head.text;
              keys++;
              const locales = Object.keys(flat).filter(code => !Object.keys(flat[code]).some(key => key.startsWith(prefix)));
              if (locales.length) missing.push({ ...where(node), key: `${prefix}*`, locales });
            }
          } else {
            // t.raw may also read a group of messages (an object or array in the catalogue).
            for (const key of found) report(node, translator.namespace ? `${translator.namespace}.${key}` : key, method === "raw");
            const mark = arg => {
              arg = unwrap(arg);
              if (ts.isStringLiteralLike(arg)) checkedLiterals.add(arg);
              else if (ts.isConditionalExpression(arg)) { mark(arg.whenTrue); mark(arg.whenFalse); }
            };
            mark(node.arguments[0]);
          }
        }
      }
      if (ts.isStringLiteralLike(node) && interfaceKeyPattern.test(node.text) && !checkedLiterals.has(node)) {
        report(node, `interface.${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: files.length, keys, dynamic, missing };
}

/**
 * Declarative JSON response transformation.
 * Supports JSONPath-like navigation, array iteration, and fallback expressions.
 */

export function applyJsonMap(data, transform) {
  if (!transform) return data;

  let root = data;

  // Navigate to root path
  if (transform.root && transform.root !== '$') {
    const parts = transform.root.replace(/^\$\.?/, '').split('.');
    for (const part of parts) {
      if (root && typeof root === 'object' && part in root) {
        root = root[part];
      } else {
        return null;
      }
    }
  }

  if (!transform.map) return root;

  if (Array.isArray(root)) {
    return root.map((item) => mapObject(item, transform.map));
  }

  return mapObject(root, transform.map);
}

function mapObject(obj, fieldMap) {
  const result = {};
  for (const [outputKey, pathExpr] of Object.entries(fieldMap)) {
    const alternatives = pathExpr.split('||').map((s) => s.trim());
    let value;
    for (const alt of alternatives) {
      value = extractValue(obj, alt);
      if (value !== undefined && value !== null) break;
    }
    result[outputKey] = value ?? null;
  }
  return result;
}

function extractValue(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  const cleanPath = path.replace(/^\$\.?/, '');
  if (!cleanPath) return obj;

  if (cleanPath.includes('[*]')) {
    const [arrayPath, rest] = cleanPath.split('[*].');
    const arr = extractValue(obj, arrayPath);
    if (Array.isArray(arr) && rest) {
      return arr.map((item) => extractValue(item, rest)).filter((v) => v !== undefined);
    }
    return arr;
  }

  const parts = cleanPath.split('.');
  let current = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

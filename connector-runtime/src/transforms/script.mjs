/**
 * Sandboxed JavaScript transform using isolated-vm (V8 isolates).
 * Each execution gets a fresh isolate with:
 * - 8 MB memory limit
 * - 1 second CPU timeout
 * - No access to Node APIs, network, or filesystem
 */

import ivm from 'isolated-vm';

const MEMORY_LIMIT_MB = 8;
const TIMEOUT_MS = 1000;

/**
 * Execute a script transform against response data.
 * @param {string} code - The transform function source code
 * @param {unknown} data - Parsed JSON from upstream API
 * @returns {Promise<unknown>} Transformed data
 */
export async function executeScriptTransform(code, data) {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    const jail = context.global;

    // Inject the data as a frozen copy
    await jail.set('__input__', new ivm.ExternalCopy(data).copyInto());

    // Wrap user code: call their transform() function with the input
    const wrappedCode = `
      ${code}
      if (typeof transform !== 'function') {
        throw new Error('Script must define a transform(data) function');
      }
      JSON.stringify(transform(__input__));
    `;

    const script = await isolate.compileScript(wrappedCode);
    const resultStr = await script.run(context, { timeout: TIMEOUT_MS });

    return JSON.parse(resultStr);
  } finally {
    isolate.dispose();
  }
}

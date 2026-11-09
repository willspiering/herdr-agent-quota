// The test host (test/host.js) and the browser preview run the mod's view in Node or a browser,
// where "herdr" and "gpui-kit" don't exist. They pass those APIs in as variables, together with
// core.js, collector.js and the providers, and run main.js inside one function.
//
// This joins main.js and the view modules it imports (state.js, reads.js, ui/*.js) into that
// function's body, as an ES module loader would: each module runs in its own scope and hands
// its exports to the modules that import it. Imports of "herdr", "gpui-*", core.js,
// collector.js and providers/ are left to the caller, who supplies those names.
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

export const MOD_DIR = fileURLToPath(new URL("../mods/agent-quota/", import.meta.url));
const SUPPLIED = /^(herdr|gpui-kit|gpui-base)$|^(core|collector)\.js$|^providers\//;
const IMPORT = /^import\s*(\{[^}]*\}|\*\s+as\s+\w+)\s*from\s*"([^"]+)";\s*$/gm;
const EXPORT = /^export\s+(default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * @param {string} [entrySource] main.js's text, to bundle another build's main.js (benchmarks).
 * @param {(path: string) => Promise<string>} [read] reads a file by its path in the mod folder.
 * @returns {Promise<string>} a function body that declares `AgentQuota` and nothing else of the view's.
 */
export async function bundleView(entrySource, read = path => readFile(posix.join(MOD_DIR, path), "utf8")) {
  const modules = new Map(), order = [];
  async function visit(path, source) {
    if (modules.has(path)) return;
    modules.set(path, null);
    const imports = [];
    for (const [, names, from] of source.matchAll(IMPORT)) {
      const target = from.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), from)) : from;
      if (SUPPLIED.test(target)) continue;
      if (!from.startsWith(".")) throw new Error(`${path}: unknown module "${from}"`);
      if (names.startsWith("*")) throw new Error(`${path}: use named imports from ${from}`);
      imports.push({ names, target });
      await visit(target, await read(target));
    }
    const exports = [...source.matchAll(EXPORT)].map(m => m[2]);
    const body = source.replace(IMPORT, "").replace(/^export\s+default\s+/gm, "").replace(/^export\s+/gm, "");
    const bindings = imports.map(({ names, target }) => `const ${names.replace(/\s+as\s+/g, ": ")} = ${variable(target)};`).join("\n");
    modules.set(path, { bindings, body, exports });
    order.push(path);
  }
  await visit("main.js", entrySource ?? await read("main.js"));
  return order.map(path => {
    const { bindings, body, exports } = modules.get(path);
    // The entry's scope returns its class, declared for the caller as `AgentQuota`.
    if (path === "main.js") return `const AgentQuota = (() => {\n${bindings}\n${body}\nreturn AgentQuota;\n})();`;
    return `const ${variable(path)} = (() => {\n${bindings}\n${body}\nreturn { ${exports.join(", ")} };\n})();`;
  }).join("\n");
}
const variable = path => `__${path.replace(/\.js$/, "").replace(/[^\w]/g, "_")}`;

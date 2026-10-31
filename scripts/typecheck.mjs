import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Type-check the mod against the declarations the installed Herdr wrote (the authority), not the
// stale gpui-kit.d.ts copy gpui-shell may have left in the repository folder.
// Configuration: strict, except noImplicitAny (the mod's ~230 untyped callback parameters) and
// strictNullChecks (off in gpui-shell's own jsconfig: view fields are assigned in init()).
// Full strict mode reports those as errors; it finds no misuse of a Herdr or gpui-kit API.
const root = fileURLToPath(new URL("../", import.meta.url));
const home = process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app");
const declarations = join(home, "gpui-kit.d.ts");
if (!existsSync(declarations)) { console.error(`No Herdr declarations at ${declarations}. Start Herdr once, then retry.`); process.exit(1); }
const strict = process.argv.includes("--strict");
// herdr.d.ts is a module file, so "herdr" is mapped to it; the config lives in artifacts/ (ignored).
const config = join(root, "artifacts/tsconfig.typecheck.json");
mkdirSync(dirname(config), { recursive: true });
writeFileSync(config, JSON.stringify({ compilerOptions: { noEmit: true, allowJs: true, checkJs: true, target: "ES2022", module: "ES2022",
  moduleResolution: "bundler", lib: ["ES2022"], strict: true, ...(strict ? {} : { noImplicitAny: false, strictNullChecks: false }),
  // The installed declarations carry a few internal lib conflicts of their own; check the mod, not them.
  skipLibCheck: true, paths: { herdr: [join(home, "herdr.d.ts")] } },
  files: [...["main.js", "core.js", "collector.js"].map(f => join(root, "mods/agent-quota", f)), declarations] }, null, 2));
const args = ["-p", config];
const r = spawnSync(join(root, "node_modules/.bin/tsc"), args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
if (r.error) { console.error(`tsc could not run (${r.error.code}). Run npm ci first.`); process.exit(1); }
process.stdout.write(r.stdout);
const errors = (r.stdout.match(/error TS\d+/g) ?? []).length;
console.log(`tsc ${strict ? "--strict" : "--strict --noImplicitAny false --strictNullChecks false"} against ${declarations}: ${errors} errors`);
process.exit(r.status === 0 ? 0 : 1);

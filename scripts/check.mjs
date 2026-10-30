import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const folder = resolve(root, "mods/agent-quota");
const result = spawnSync("herdr-app", ["check", folder], { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(`Native check could not finish: ${result.error.code}. Run this from a normal macOS terminal with Herdr installed.`);
process.exit(result.status === 0 ? 0 : 1);

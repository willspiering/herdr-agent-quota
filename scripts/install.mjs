import { readFile, writeFile, mkdir, access, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { integrateLayout, bindToggle, MOD } from "./layout.mjs";
import { swapBuild } from "./swap.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app");
const args = new Set(process.argv.slice(2));
if ([...args].some(a => !["--plan", "--headers", "--no-deps"].includes(a))) throw new Error("Usage: npm run setup -- [--plan] [--headers] [--no-deps]");
const readJSON = async path => JSON.parse(await readFile(path, "utf8"));
const exists = async path => access(path).then(() => true, () => false);
const cli = (command, argv, timeout = 30000) => {
  const r = spawnSync(command, argv, { cwd: root, encoding: "utf8", timeout, killSignal: "SIGKILL", env: { ...process.env, HERDR_APP_HOME: home } });
  if (r.error || r.status !== 0) throw new Error(`${command} ${argv[0]} failed${r.error ? ` (${r.error.code})` : ""}. ${r.stderr?.slice(-1500) || ""}`);
  return r.stdout;
};

try {
  const state = await readJSON(join(home, "shared.json")).catch(() => ({}));
  const sourceName = typeof state.layout === "string" && /^[\w-]+$/.test(state.layout) ? state.layout : "main";
  const source = await readJSON(join(home, "layouts", `${sourceName}.json`));
  const preview = integrateLayout(source, { headers: args.has("--headers") });
  const cloneName = "agent-quota";
  const installedPath = join(home, "mods", MOD);
  // Generated files are hidden: Herdr reloads every copy when a mod file is saved, but not for
  // hidden files, so writing them never reloads the mod. Older installs used visible names.
  const markerPath = join(installedPath, ".installation.json");
  const legacy = ["runtime.json", "installation.json"];
  const marker = await readJSON(markerPath).catch(() => readJSON(join(installedPath, "installation.json")).catch(() => null));
  if (await exists(installedPath) && marker?.project !== "herdr-agent-quota") throw new Error("The agent-quota mod name is already taken; no files changed.");
  if (await exists(join(home, "layouts", `${cloneName}.json`)) && marker?.layout !== cloneName) throw new Error("The agent-quota layout name is already taken; no files changed.");
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(join(root, "artifacts/layout-preview.json"), JSON.stringify(preview, null, 2) + "\n");
  if (args.has("--plan")) {
    console.log(`Plan: install mods/${MOD}, clone ${sourceName} as ${cloneName}, add a quota status block, a hidden dashboard column${args.has("--headers") ? ", pane headers" : ""} and a free toggle key.`);
    console.log("The mod runs quota-axi, which reads local agent sign-ins and calls first-party provider usage services. No keys are copied into the mod.");
    console.log("Layout preview: artifacts/layout-preview.json. Herdr configuration was not changed.");
    process.exit(0);
  }
  if (!args.has("--no-deps")) {
    console.log("Installing quota-axi 0.1.69 from the lockfile (integrity-checked, package scripts disabled)…");
    cli(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], 180000);
  }
  const collector = join(root, "node_modules/quota-axi/dist/bin/quota-axi.js");
  if (!await exists(collector)) throw new Error("quota-axi is missing. Run npm ci --ignore-scripts first.");
  console.log("Checking the native mod…");
  cli("herdr-app", ["check", join(root, "mods", MOD)]);
  await mkdir(installedPath, { recursive: true });
  // 1. Hidden files first (no reload): the new build finds its runtime the moment it loads.
  await writeFile(join(installedPath, ".runtime.json"), JSON.stringify({ node: process.execPath, collector, runner: join(root, "scripts/collect.mjs") }, null, 2) + "\n");
  // Mark our files before the live commands, so interrupted setup can retry.
  await writeFile(markerPath, JSON.stringify({ project: "herdr-agent-quota", version: "0.1.0", layout: cloneName, previousLayout: marker?.previousLayout ?? sourceName, source: root }, null, 2) + "\n");
  // 2. Stage the build beside the mods folder (same volume, so renames are atomic), then swap
  //    every changed file in one synchronous step: one reload, never a mixed build.
  const changed = await swapBuild(join(root, "mods", MOD), installedPath, join(home, `.agent-quota-staging-${process.pid}`), legacy);
  console.log(changed ? `Installed ${changed} changed file(s) in one step.` : "Installed build is already current.");
  if (!await exists(join(home, "layouts", `${cloneName}.json`))) {
    // Clone through Herdr so its existing click state is preserved.
    cli("herdr-app", ["do", "layout.clone", JSON.stringify({ name: sourceName, as: cloneName })]);
  }
  const layoutPath = join(home, "layouts", `${cloneName}.json`);
  const current = await readFile(layoutPath, "utf8");
  const next = integrateLayout(JSON.parse(current), { headers: args.has("--headers") });
  await writeFile(join(root, "artifacts/layout-before.json"), current);
  // Refuse an edit that raced this installer.
  if (await readFile(layoutPath, "utf8") !== current) throw new Error("Layout changed during setup. Run setup again.");
  await writeFile(layoutPath, JSON.stringify(next, null, 2) + "\n");
  await writeFile(markerPath, JSON.stringify({ project: "herdr-agent-quota", version: "0.1.0", layout: cloneName, previousLayout: marker?.previousLayout ?? sourceName, source: root }, null, 2) + "\n");
  cli("herdr-app", ["do", "layout.switch", JSON.stringify({ name: cloneName })]);
  // A key for the dashboard column, only if it is free; the person's keys are never replaced.
  const keysPath = join(home, "keys.json");
  const keysText = await readFile(keysPath, "utf8").catch(() => "{}");
  const keys = bindToggle(JSON.parse(keysText));
  if (keys && JSON.stringify(keys) !== JSON.stringify(JSON.parse(keysText))) {
    await writeFile(`${keysPath}.agent-quota-tmp`, JSON.stringify(keys, null, 2) + "\n");
    await rename(`${keysPath}.agent-quota-tmp`, keysPath);
  }
  const toggleKey = process.platform === "darwin" ? "cmd-shift-u" : "ctrl-shift-u";
  console.log(keys ? `Dashboard key: ${toggleKey} (in the agent-quota layout).` : `${toggleKey} is already bound; the dashboard opens from the quota strip.`);
  cli("herdr-app", ["check", installedPath]);
  const status = cli("herdr-app", ["status"]);
  await writeFile(join(root, "artifacts/install-status.txt"), status);
  console.log(status.trim());
  console.log(`Installed. Click the quota strip at the bottom right to open the dashboard column. Original layout: ${marker?.previousLayout ?? sourceName}.`);
  console.log(`To return: herdr-app do layout.switch '{"name":"${marker?.previousLayout ?? sourceName}"}'`);
} catch (error) { console.error(error.message); process.exitCode = 1; }

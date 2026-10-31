import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHost, walk } from "../test/host.js";
import * as currentCore from "../mods/agent-quota/core.js";

// Synthetic descriptions in Node/V8, not Herdr/QuickJS or GPU measurements. No quota reads,
// installed mod edits, account data or live agent state are used.
const baseline = process.argv[2] ?? "fbb7f2b";
if (!/^[0-9a-f]{7,40}$/.test(baseline)) throw Error("Pass a commit hash to compare.");
const git = path => execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8", maxBuffer: 1024 * 1024 });
const baselineCore = await import(`data:text/javascript;base64,${Buffer.from(git("mods/agent-quota/core.js")).toString("base64")}`);
const sources = { before: { source: git("mods/agent-quota/main.js"), coreModule: baselineCore },
  after: { source: await readFile(new URL("../mods/agent-quota/main.js", import.meta.url), "utf8"), coreModule: currentCore } };
const now = Date.now();
const fixture = (accounts, limits) => currentCore.parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(),
  providers: Array.from({ length: accounts }, (_, i) => ({ provider: "codex", accountKey: `${i}`, state: { status: "fresh" },
    windows: Array.from({ length: limits }, (_, j) => ({ id: `${j}`, label: `Limit ${j}`, kind: "weekly", percentUsed: 50 })) })) }));
const result = { baseline, runtime: process.version, native: false, scenarios: [] };
for (const [scenario, data] of [["ordinary", fixture(3, 2)], ["large", fixture(40, 20)]]) {
  for (const page of ["overview", "configure"]) for (const [version, code] of Object.entries(sources)) {
    const host = await createHost({ data, ...code }); host.view.page = page;
    for (let i = 0; i < 3; i++) host.tree();
    const samples = [];
    for (let i = 0; i < 25; i++) { const start = performance.now(); host.tree(); samples.push(performance.now() - start); }
    samples.sort((a, b) => a - b);
    let nodes = 0, paths = 0, pathCommands = 0;
    walk(host.tree(), n => { nodes++; if (n.type === "path") { paths++; pathCommands += n.value.commands.length; } });
    result.scenarios.push({ scenario, page, version, nodes, paths, pathCommands, p50Ms: +samples[12].toFixed(3), p95Ms: +samples[23].toFixed(3) });
  }
}
for (const [version, { coreModule }] of Object.entries(sources)) {
  let reads = 0;
  const spaces = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}`, machine: null }));
  const live = spaces.map((_, i) => ({ address: `t${i}`, program: { key: "codex" }, status: "working", get space() { reads++; return `${i}`; } }));
  const start = performance.now();
  coreModule.catalog(fixture(100, 2), [], live, spaces, coreModule.options());
  result.scenarios.push({ scenario: "100 accounts / 1000 agents / 1000 spaces", version, spaceLookups: reads, elapsedMs: +(performance.now() - start).toFixed(3) });
}
console.log(JSON.stringify(result, null, 2));

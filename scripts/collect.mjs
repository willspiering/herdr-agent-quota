import { isAbsolute, join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { runBounded, groupAlive, MAX_OUTPUT, SUPERVISOR_MS, GRACE_MS } from "./collector-process.mjs";
import { ARGS } from "../mods/agent-quota/collector.js";
import { parseReport, providerId } from "../mods/agent-quota/core.js";

const posix = process.platform !== "win32";
const [collector, deadlineArg, ...ids] = process.argv.slice(2), deadline = Number(deadlineArg);
if (!collector || !isAbsolute(collector) || !Number.isFinite(deadline) || ids.length > 200 || ids.some(id => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))) process.exit(126);

// Process groups this supervisor started, so a read that was SIGKILLed (untrappable) can be
// reaped by the next one. Outside Herdr's mod folder: writing here never reloads the mod.
const groups = join(process.env.HERDR_AGENT_QUOTA_STATE_DIR || fileURLToPath(new URL("../.runtime/", import.meta.url)), "groups");
const record = pid => join(groups, `${pid}.json`);
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The group still runs a collector started with our argv (guards against a reused group id).
const runsCollector = group => spawnSync("pgrep", ["-g", String(group), "-f", "--", escape(ARGS.join(" "))], { stdio: "ignore", timeout: 2000 }).status === 0;
function reap() {
  let names;
  try { names = readdirSync(groups); } catch { return; }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let entry = null;
    try { entry = JSON.parse(readFileSync(join(groups, name), "utf8")); } catch { /* unreadable: drop it */ }
    if (entry && pidAlive(entry.supervisor)) continue; // a live read owns it
    if (entry && Number.isInteger(entry.group) && groupAlive(entry.group) && runsCollector(entry.group)) {
      try { process.kill(-entry.group, "SIGKILL"); } catch { /* exited meanwhile */ }
    }
    rmSync(join(groups, name), { force: true });
  }
}
if (posix) reap();

// Budget from this process's own start, never more than SUPERVISOR_MS, so it always ends before
// Herdr's 30 s cap. The claim deadline still bounds it: a queued launch past it never starts.
const budget = Math.min(SUPERVISOR_MS, Number(process.env.HERDR_AGENT_QUOTA_SUPERVISOR_MS) || SUPERVISOR_MS);
const timeout = Math.min(deadline, Math.round(performance.timeOrigin) + budget) - Date.now() - GRACE_MS;
if (timeout <= 0) process.exit(124);

// Herdr, a terminal or a user stopping this supervisor stops the collector's group with it.
let group = 0;
const forget = () => { if (group) rmSync(record(group), { force: true }); };
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.once(sig, () => {
  if (group) { try { process.kill(posix ? -group : group, "SIGKILL"); } catch { /* already gone */ } }
  forget();
  process.exit(128 + constants.signals[sig]);
});
const onSpawn = pid => {
  group = pid;
  if (!posix) return;
  try { mkdirSync(groups, { recursive: true }); writeFileSync(record(pid), JSON.stringify({ group: pid, supervisor: process.pid })); }
  catch { /* best effort: the budget and signal traps still bound the read */ }
};

const result = await runBounded(process.execPath, [collector, ...ARGS, ...(ids.length ? ["--provider", ids.join(",")] : [])], { timeout, onSpawn });
forget();
if (result.code !== 0 && result.code !== 1) process.exit(result.code);
try {
  // Drop raw/audit fields outside Herdr's script thread. Only this allowlist reaches it.
  const data = parseReport(result.stdout);
  const input = JSON.parse(result.stdout).providers.slice(0, 200)
    .filter(p => typeof p?.provider === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerId(p.provider)));
  const identity = v => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160) : "";
  const report = { schemaVersion: data.schema, generatedAt: new Date(data.at).toISOString(), providers: data.providers.map((p, i) => ({
    // Keep the distinction between a single lane and folded membership. Serializing the
    // joined account string as accountKey would truncate long identities on the next parse.
    provider: p.axi ?? p.id, accountKey: identity(input[i].accountKey),
    accountKeys: Array.isArray(input[i].accountKeys) ? input[i].accountKeys.map(identity).filter(Boolean) : [], label: p.label, plan: p.plan,
    state: { status: p.status, stale: p.stale, reused: p.reused, refreshedAt: new Date(p.at).toISOString() },
    untrustedWindowIds: p.windows.filter(w => !w.trusted).map(w => w.id),
    windows: p.windows.map(w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed, shareOf: w.shareOf,
      resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt).toISOString(), windowSeconds: w.windowSeconds,
      pace: { status: w.paceStatus, timeRemainingPercent: w.elapsedPercent === null ? null : 100 - w.elapsedPercent } })),
  })) };
  const output = JSON.stringify(report);
  if (Buffer.byteLength(output) > MAX_OUTPUT) process.exit(125);
  process.stdout.write(output);
  process.exitCode = result.code;
} catch { process.exitCode = 126; }

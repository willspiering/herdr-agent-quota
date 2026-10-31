import { isAbsolute } from "node:path";
import { runBounded, MAX_OUTPUT } from "./collector-process.mjs";
import { ARGS } from "../mods/agent-quota/collector.js";
import { parseReport, providerId } from "../mods/agent-quota/core.js";

const [collector, deadlineArg, ...ids] = process.argv.slice(2), deadline = Number(deadlineArg);
if (!collector || !isAbsolute(collector) || !Number.isFinite(deadline) || ids.length > 200 || ids.some(id => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))) process.exit(126);
// The deadline starts when Herdr claims the work, not when a queued exec finally launches.
// Delayed launches cannot extend a subprocess beyond the shared claim's lifetime.
const remaining = deadline - Date.now() - 250;
if (remaining <= 0) process.exit(124);
const result = await runBounded(process.execPath, [collector, ...ARGS, ...(ids.length ? ["--provider", ids.join(",")] : [])], { timeout: Math.min(30000, remaining) });
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

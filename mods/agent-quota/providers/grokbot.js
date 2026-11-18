// Grok Bot's weekly included usage. Grok Bot runs on a Cursor account but is metered apart from
// Cursor's plan: the dashboard's GetSandUsageStatus RPC ("Sand" is its internal name) says how much
// of this week's allowance is gone and when it resets. It is asked as the same account the Cursor
// provider reads, found the same way, so the two never describe different people. Never refreshes
// a token. Matches Omarchy's grokbot collector (omarchy-agent-usage-grokbot).
import { ReadFailure, obj, num, str, name as plain, clampPercent, lane } from "./common.js";
import { withSignIn, rpc, cycleWindow, time } from "./cursor.js";

export const id = "grokbot";
export const label = "Grok Bot";
export const agents = [];
export const icon = "icons/grok.svg";
export const platforms = {
  macos: "Cursor sign-in: editor database (sqlite3), Cursor CLI (Keychain)",
  linux: "Cursor sign-in: editor database (sqlite3), Cursor CLI (~/.config/cursor/auth.json)",
  windows: null,
};

const pick = (data, camel, snake) => data[camel] !== undefined ? data[camel] : data[snake];

/** The weekly window in one GetSandUsageStatus answer; none when the account has no allowance. */
export function weeklyWindow(raw, now) {
  const data = obj(raw);
  if (!data || pick(data, "usesPooledEnterpriseAllowance", "uses_pooled_enterprise_allowance") === true) return undefined;
  let percent = num(pick(data, "usagePercent", "usage_percent"));
  // Protobuf JSON leaves out a field holding zero, so an account with an allowance and nothing
  // used yet has no percentage: that is a reported 0%, not a missing one. Without the allowance
  // flag a missing percentage stays missing.
  if (percent === undefined && pick(data, "hasNonZeroIncludedLimit", "has_non_zero_included_limit") === true) percent = 0;
  if (percent === undefined) return undefined;
  return cycleWindow(now, { id: "weekly", label: "weekly included usage", kind: "weekly", percentUsed: clampPercent(percent),
    resetsAt: time(pick(data, "nextResetTimestampUtc", "next_reset_timestamp_utc")) }, time(pick(data, "currentPeriodStart", "current_period_start")));
}

async function sand(io, sign, now) {
  const answer = await rpc(io, "GetSandUsageStatus", sign.token);
  if (answer.auth) return null;
  if (!obj(answer.body)) throw new ReadFailure("malformed");
  const window = weeklyWindow(answer.body, now);
  // A Cursor account without Grok Bot: read, with nothing to show, so the dashboard skips it.
  if (!window) return lane(id, label, now);
  return lane(id, label, now, { plan: plain(str(answer.body.grokPlanLabel) ?? str(answer.body.grok_plan_label)) ?? null, windows: [window] });
}

export async function read(io) {
  return withSignIn(io, id, label, sign => sand(io, sign, io.now));
}

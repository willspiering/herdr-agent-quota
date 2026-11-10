// The provider contract (providers/index.js), checked for every provider so a new one can't
// miss a field. docs/adding-a-provider.md describes each.
import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, ALIASES, ICONS } from "../mods/agent-quota/providers/index.js";
import { PLATFORMS } from "../mods/agent-quota/providers/platform.js";
import { providerId } from "../mods/agent-quota/core.js";

test("every provider exports the full contract", () => {
  const ids = new Set();
  for (const a of ADAPTERS) {
    assert.match(a.id, /^[a-z0-9-]+$/, "id: lowercase, stable");
    assert.ok(!ids.has(a.id), `${a.id}: duplicate id`); ids.add(a.id);
    assert.ok(typeof a.label === "string" && a.label.length > 0 && a.label.length <= 24, `${a.id}: label`);
    assert.ok(Array.isArray(a.agents) && a.agents.every(n => typeof n === "string" && n === n.toLowerCase()), `${a.id}: agents are lowercase names`);
    assert.match(a.icon, /^[\w./-]+\.svg$/, `${a.id}: icon`);
    assert.deepEqual(Object.keys(a.platforms).sort(), [...PLATFORMS].sort(), `${a.id}: platforms names every system`);
    for (const system of PLATFORMS) assert.ok(a.platforms[system] === null || typeof a.platforms[system] === "string", `${a.id}: ${system}`);
    assert.equal(typeof a.read, "function", `${a.id}: read(io)`);
  }
});

test("Herdr agents map to providers through each provider's own list", () => {
  for (const a of ADAPTERS) {
    assert.equal(providerId(a.id), a.id);
    for (const name of a.agents) {
      assert.ok(!ADAPTERS.some(b => b.id === name), `${name} is another provider's id`);
      assert.equal(providerId(name), a.id);
      assert.equal(providerId(name.toUpperCase()), a.id, "case doesn't matter");
    }
    assert.equal(ICONS[a.id], a.icon);
  }
  assert.equal(Object.keys(ALIASES).length, ADAPTERS.reduce((n, a) => n + a.agents.length, 0), "no name claimed twice");
  assert.equal(providerId("some-new-agent"), "some-new-agent", "an unknown agent keeps its own id");
});

test("the README's platform table matches what each provider declares", async () => {
  const { readFile } = await import("node:fs/promises");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const rows = new Map(readme.split("\n").filter(l => l.startsWith("| ")).map(l => l.split("|").slice(1, -1).map(c => c.trim())).map(([name, ...cells]) => [name, cells]));
  for (const a of ADAPTERS) {
    const want = PLATFORMS.map(system => a.platforms[system] ?? "Not supported");
    assert.deepEqual(rows.get(a.label), want, `README row for ${a.label}: update it to match providers/${a.id}.js`);
  }
});

import { readFile, mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../mods/agent-quota/core.js";
import * as collector from "../mods/agent-quota/collector.js";

// What Herdr's exec does at its limits (herdr.d.ts: "30 s limit, 8 MiB output"). The binary's
// message is "<program> took longer than 30 s and was stopped".
export const EXEC_CAP_MS = 30000;
export const EXEC_MAX_OUTPUT = 8 * 1024 * 1024;

export class Element {
  constructor(type = "div", value = null) {
    this.type = type; this.value = value; this.styles = {}; this.nodes = []; this.events = {};
    return new Proxy(this, { get: (target, prop, receiver) => {
      if (prop in target) return target[prop];
      return (...args) => { target.styles[prop] = args; return receiver; };
    } });
  }
  // Herdr's GPUI rejects anything else (seen natively: "child(value) expects an element, a
  // string, or an entity from cx.new(Class, props)"), including null from an optional part.
  child(value) {
    if (!(value instanceof Element) && typeof value !== "string" && typeof value !== "number") throw new TypeError("child(value) expects an element, a string, or an entity from cx.new(Class, props)");
    this.nodes.push(value); return this;
  }
  children(values) { for (const value of values) this.child(value); return this; }
  when(condition, fn) { return condition ? fn(this) : this; }
  on_click(fn) { this.events.click = fn; return this; }
  on_key_down(fn) { this.events.keydown = fn; return this; }
  on_mouse_down(button, fn) { this.events[`mouse-${button}`] = fn; return this; }
  on_size_change(fn) { this.events.size = fn; return this; }
  hover() { return this; }
}
export const constructors = {
  View: class {}, div: () => new Element(), h_flex: () => new Element("row"), v_flex: () => new Element("column"),
  svg: value => new Element("svg", value), image: value => new Element("image", value),
  Button: { new: id => new Element("button").id(id) },
  PathBuilder: { fill: () => path(), stroke: () => path() },
  Background: { solid: color => ({ color, opacity: () => ({ color }) }) },
  // Painted paths become elements that record their host commands and fill, like Herdr's shim:
  // each move_to, line_to, arc_to, close and dash_array is one call into the host.
  window: { paint_path: (built, fill) => new Element("path", { commands: built.commands, fill: fill?.color ?? fill }) },
};
function path() {
  const commands = [];
  const builder = {};
  for (const name of ["move_to", "line_to", "arc_to", "curve_to", "close", "dash_array"]) builder[name] = (...args) => { commands.push([name, ...args]); return builder; };
  builder.add_polygon = points => { points.forEach((pt, i) => commands.push([i ? "line_to" : "move_to", ...pt])); commands.push(["close"]); return builder; };
  builder.build = () => ({ commands });
  return builder;
}
export const palette = {
  foreground: "#e5e7ec", muted: "#abb0bc", dim: "#888e9b", border: "#363940", input: "#687184", accent: "#8bb3e6",
  popover: "#202228", surface: "#25282f", chrome: "#191b20", background: "#202228", hover: "#34373f", selected: "#303946",
  working: "#e1bc75", blocked: "#f48e83", done: "#80c9ae", idle: "#abb0bc",
  ansi1: "#e06c75", ansi2: "#98c379", ansi3: "#e5c07b",
};
export function walk(element, visit) {
  if (!(element instanceof Element)) return;
  visit(element);
  for (const node of element.nodes) walk(node, visit);
}
export function flatten(element) {
  if (typeof element === "string" || typeof element === "number") return String(element);
  return element?.nodes?.map(flatten).join(" ") ?? "";
}

// Herdr persists shared state, so every read is a fresh deserialized copy and a write
// never aliases the caller's object.
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// A separate module graph per copy, as when Herdr loads a mod build: main's core.js and
// collector's core.js are one instance, but a second copy has its own.
let copies = 0;
export async function independentModules() {
  const dir = await mkdtemp(join(tmpdir(), `quota-copy-${copies++}-`));
  await cp(new URL("../mods/agent-quota/", import.meta.url), dir, { recursive: true });
  return { coreModule: await import(pathToFileURL(join(dir, "core.js"))), collectorModule: await import(pathToFileURL(join(dir, "collector.js"))) };
}

// Bound a fake exec the way Herdr does: stop it at the cap (calling its kill hook, as Herdr
// stops the process) and reject; reject output beyond 8 MiB.
export function cappedExec(runner, { cap = EXEC_CAP_MS, onStop = () => {} } = {}) {
  return (command, args = [], options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onStop(); reject(new Error(`${command} took longer than 30 s and was stopped`)); }, cap);
    timer.unref?.();
    Promise.resolve().then(() => runner(command, args, options)).then(result => {
      clearTimeout(timer);
      let size = 0;
      try { size = typeof result?.stdout === "string" ? Buffer.byteLength(result.stdout) : 0; } catch { /* the caller reads it */ }
      if (size > EXEC_MAX_OUTPUT) reject(new Error(`${command} output exceeded 8 MiB`));
      else resolve(result);
    }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function createHost({ nextCommand = () => new Promise(() => {}), mode = "dashboard", data = null, live = [], installed = [], paneList = [], spaceList = [], runtime = {}, runtimeFile = null, runner, sharedState, clock, source: inputSource, coreModule = core, collectorModule = collector, execCap = EXEC_CAP_MS, layoutTree = null } = {}) {
  const source = inputSource ?? await readFile(new URL("../mods/agent-quota/main.js", import.meta.url), "utf8");
  const state = sharedState ?? { [`${core.PREFIX}.data`]: copy(data), [`${core.PREFIX}.discovered`]: copy(installed) };
  const properties = { mode, ...runtime };
  const tasks = [], spawns = [], timers = [], overlays = [], commands = [], writes = [], sharedReads = [], reads = { agents: 0, spaces: 0 }, renders = { requested: 0 };
  let phase = "init", retired = false;
  const focus = { allocations: 0 };
  const cx = {
    focus_handle() {
      if (phase === "render") throw new Error("cx.focus_handle() cannot run during render");
      focus.allocations++;
      return { focus() {}, is_focused: () => false };
    }, notify() { renders.requested++; },
    // A replaced build's loop ends at its next cx use.
    phase() { if (retired) throw new Error("view released"); return phase; }, stop_propagation() {},
    spawn(fn, opts) { tasks.push(fn); spawns.push(opts); },
    timer: { every(ms, fn) { timers.push({ ms, fn }); }, after(ms, fn) { timers.push({ ms, fn, once: true }); } },
  };
  const api = {
    exec: cappedExec(runner ?? (async () => { throw Error("Not installed"); }), { cap: execCap }),
    appHome: () => "/preview", readTextFile: async () => runtimeFile && JSON.stringify(runtimeFile),
    knownAgents: async () => installed, agents: () => (reads.agents++, live), spaces: () => (reads.spaces++, spaceList), panes: () => paneList,
    theme: () => palette, settings: () => ({ dark: true, font_family: "JetBrains Mono" }),
    shared: name => { sharedReads.push(name); return copy(state[name]); },
    // Herdr re-renders every mod in the window on each write.
    setShared: (name, value) => { writes.push(name); state[name] = copy(value); renders.requested++; return null; },
    props: () => properties, openOverlay: spec => { overlays.push(spec); return "overlay"; }, closeOverlay: id => commands.push(["close", id]),
    nextCommand, run: (name, args) => commands.push([name, args]),
    // The shown layout with its clicks applied (a toggled node's `hidden`), or null.
    layout: () => copy(layoutTree),
  };
  const deps = { ...constructors, ...api, ...coreModule, ...collectorModule, Date: clock ? class extends Date { static now() { return clock.now; } } : Date };
  const code = source.replace(/import[\s\S]*?from\s+"[^";]+";/g, "").replace("export function colors", "function colors").replace("export default class AgentQuota", "class AgentQuota");
  const AgentQuota = new Function(...Object.keys(deps), `${code}\nreturn AgentQuota;`)(...Object.values(deps));
  const view = new AgentQuota(); view.init(properties, cx);
  return { view, cx, state, setLayout(next) { layoutTree = next; }, tasks, spawns, timers, overlays, commands, writes, reads, renders, sharedReads, properties, focus,
    retire() { retired = true; },
    tree() {
      phase = "render";
      try { return view.render(cx); } finally { phase = "event"; }
    } };
}

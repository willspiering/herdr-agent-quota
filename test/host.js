import { readFile } from "node:fs/promises";
import * as core from "../mods/agent-quota/core.js";
import * as collector from "../mods/agent-quota/collector.js";

export class Element {
  constructor(type = "div", value = null) {
    this.type = type; this.value = value; this.styles = {}; this.nodes = []; this.events = {};
    return new Proxy(this, { get: (target, prop, receiver) => {
      if (prop in target) return target[prop];
      return (...args) => { target.styles[prop] = args; return receiver; };
    } });
  }
  child(value) { if (value !== null && value !== undefined) this.nodes.push(value); return this; }
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
};
export const palette = {
  foreground: "#e5e7ec", muted: "#abb0bc", dim: "#888e9b", border: "#363940", input: "#687184", accent: "#8bb3e6",
  popover: "#202228", surface: "#25282f", chrome: "#191b20", background: "#202228", hover: "#34373f", selected: "#303946",
  working: "#e1bc75", blocked: "#f48e83", done: "#80c9ae", idle: "#abb0bc",
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
export async function createHost({ mode = "dashboard", data = null, live = [], installed = [], paneList = [], spaceList = [], runtime = {}, runner } = {}) {
  const source = await readFile(new URL("../mods/agent-quota/main.js", import.meta.url), "utf8");
  const state = { [`${core.PREFIX}.data`]: data, [`${core.PREFIX}.discovered`]: installed };
  const properties = { mode, ...runtime };
  const tasks = [], timers = [], overlays = [], commands = [];
  let phase = "init";
  const focus = { allocations: 0 };
  const cx = {
    focus_handle() {
      if (phase === "render") throw new Error("cx.focus_handle() cannot run during render");
      focus.allocations++;
      return { focus() {}, is_focused: () => false };
    }, notify() {}, stop_propagation() {},
    spawn(fn) { tasks.push(fn); }, timer: { every(ms, fn) { timers.push({ ms, fn }); } },
  };
  const api = {
    exec: runner ?? (async () => { throw Error("Not installed"); }), appHome: () => "/preview", readTextFile: async () => null,
    knownAgents: async () => installed, agents: () => live, spaces: () => spaceList, panes: () => paneList,
    theme: () => palette, settings: () => ({ dark: true }), shared: name => state[name], setShared: (name, value) => { state[name] = value; },
    props: () => properties, openOverlay: spec => { overlays.push(spec); return "overlay"; }, closeOverlay: id => commands.push(["close", id]),
    nextCommand: () => new Promise(() => {}), run: (name, args) => commands.push([name, args]),
  };
  const deps = { ...constructors, ...api, ...core, ...collector };
  const code = source.replace(/import[\s\S]*?from\s+"[^";]+";/g, "").replace("export function colors", "function colors").replace("export default class AgentQuota", "class AgentQuota");
  const AgentQuota = new Function(...Object.keys(deps), `${code}\nreturn AgentQuota;`)(...Object.values(deps));
  const view = new AgentQuota(); view.init(properties, cx);
  return { view, cx, state, tasks, timers, overlays, commands, properties, focus, tree() {
    phase = "render";
    try { return view.render(cx); } finally { phase = "event"; }
  } };
}

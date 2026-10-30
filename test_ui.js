/*
 * 用最小 DOM stub 跑一遍 ui.js 的“开局 -> 渲染 -> 掷骰”路径，
 * 目的是抓运行时报错，不是替代真浏览器。
 *
 *   node test_ui.js
 */
class El {
  constructor(tag) {
    this.tag = tag || "div";
    this.children = [];
    this.listeners = {};
    this._innerHTML = "";
    this.textContent = "";
    this.className = "";
    this.value = "";
    this.scrollTop = 0;
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
    };
  }
  set innerHTML(v) { this._innerHTML = v; this.children = []; }
  get innerHTML() { return this._innerHTML; }
  appendChild(c) { this.children.push(c); }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  querySelectorAll(sel) {
    if (sel === "input") return this.children.filter((c) => c.tag === "input");
    return [];
  }
}

const ids = {};
const el = (id) => ids[id] || (ids[id] = new El("div"));

global.document = {
  _ready: [],
  querySelector(sel) {
    if (sel.startsWith("#")) return el(sel.slice(1));
    return null;
  },
  createElement(tag) { return new El(tag); },
  addEventListener(ev, fn) { if (ev === "DOMContentLoaded") this._ready.push(fn); },
};
global.window = globalThis;
global.location = { search: "" };
global.alert = (m) => { throw new Error("alert: " + m); };
global.confirm = () => true;
global.print = () => {};

require("./engine.js");
require("./ui.js");

global.document._ready.forEach((fn) => fn());

const click = (e) => (e.listeners.click || []).forEach((fn) => fn({ target: e }));

try {
  click(ids["startBtn"]);
  console.log("player cards:", ids["players"].children.length);
  console.log("actions buttons:", ids["actions"].children.length);
  console.log("prompt:", ids["prompt"].textContent);

  const first = ids["actions"].children[0];
  if (!first) throw new Error("no action button");
  click(first);
  console.log("after roll click, prompt:", ids["prompt"].textContent);
  setTimeout(() => {
    console.log("after 800ms prompt:", ids["prompt"].textContent);
    console.log("after 800ms actions:", ids["actions"].children.length);

    const cards = ids["players"].children;
    const target = cards.find((c) => (c.listeners.click || []).length > 0);
    if (target) {
      click(target);
      console.log("after target click prompt:", ids["prompt"].textContent);
      console.log("after target click actions:", ids["actions"].children.length);
    } else {
      console.log("no targetable card (phase may be action/end)");
    }

    console.log("UI smoke test OK");
  }, 800);
} catch (err) {
  console.error("UI smoke test FAILED:", err);
  process.exitCode = 1;
}

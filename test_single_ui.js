/*
 * 鐢ㄦ渶灏?DOM stub 璺戜竴閬?ui.js 鐨勨€滃紑灞€ -> 娓叉煋 -> 鎺烽鈥濊矾寰勶紝
 * 鐩殑鏄姄杩愯鏃舵姤閿欙紝涓嶆槸鏇夸唬鐪熸祻瑙堝櫒銆? *
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

require("./engine_single.js");
require("./ui_single.js");

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

    const findBtn = (txt) => ids["actions"].children.find((b) => (b.textContent || "").includes(txt));
    const cards = ids["players"].children;
    let target = cards.find((c) => (c.listeners.click || []).length > 0);

    if (findBtn("射击")) {
      click(findBtn("射击"));
      console.log("after 射击 prompt:", ids["prompt"].textContent);
    }
    if (target) {
      click(target);
      console.log("after target click prompt:", ids["prompt"].textContent);
    }
    if (findBtn("结束回合")) {
      click(findBtn("结束回合"));
      console.log("after end click prompt:", ids["prompt"].textContent);
    }

    console.log("UI smoke test OK");
  }, 800);
} catch (err) {
  console.error("UI smoke test FAILED:", err);
  process.exitCode = 1;
}


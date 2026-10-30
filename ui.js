/* 《六面》v1.4 试玩版 —— 浏览器 UI */
(function () {
  "use strict";

  const { Game, ID } = window.DiceGame;
  const FACE_NAMES = {
    1: "劣质毒药",
    2: "骰子霰弹枪",
    3: "金质骰子",
    4: "电量炸弹",
    5: "骰利刃",
    6: "随机生成器",
  };
  const TARGET_LABEL = {
    poison: "下毒目标",
    shotgun: "射击目标",
    random: "改 HP 目标",
    blade: "刃击目标",
    chargeDamage: "2 伤目标",
    hunterShot: "猎枪目标",
    divine: "神之刃目标",
    hunterGun: "猎枪目标",
  };

  let game = null;
  let count = 4;
  let busy = false;

  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    renderSetup();
    $("#startBtn").addEventListener("click", start);
    $("#restartBtn").addEventListener("click", () => {
      if (!game || confirm("重开一局？")) showSetup();
    });
    $("#rulesBtn").addEventListener("click", () => $("#rules").classList.remove("hidden"));
    $("#closeRules").addEventListener("click", () => $("#rules").classList.add("hidden"));
    $("#printBtn").addEventListener("click", () => window.print());
    $("#rules").addEventListener("click", (e) => {
      if (e.target === $("#rules")) $("#rules").classList.add("hidden");
    });

    // 方便截图/快速试玩：play.html?demo=5 直接开一局 5 人
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo) {
      count = Math.max(3, Math.min(6, parseInt(demo, 10) || 5));
      renderSetup();
      start();
    }
  }

  /* ---------------- 开局 ---------------- */
  function renderSetup() {
    const cb = $("#countButtons");
    cb.innerHTML = "";
    for (let n = 3; n <= 6; n++) {
      const b = document.createElement("button");
      b.textContent = n + " 人";
      if (n === count) b.className = "active";
      b.addEventListener("click", () => {
        count = n;
        renderSetup();
      });
      cb.appendChild(b);
    }

    const old = [...$("#nameInputs").querySelectorAll("input")].map((i) => i.value);
    const ni = $("#nameInputs");
    ni.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const inp = document.createElement("input");
      inp.value = old[i] || "P" + (i + 1);
      inp.maxLength = 12;
      inp.placeholder = "P" + (i + 1);
      ni.appendChild(inp);
    }
  }

  function start() {
    const inputs = [...$("#nameInputs").querySelectorAll("input")];
    const names = inputs.map((inp, i) => inp.value.trim() || "P" + (i + 1));
    try {
      game = new Game(names);
    } catch (err) {
      alert("开局失败：" + err.message);
      console.error(err);
      return;
    }
    $("#setup").classList.add("hidden");
    render();
  }

  function showSetup() {
    game = null;
    $("#setup").classList.remove("hidden");
    $("#players").innerHTML = "";
    $("#log").innerHTML = "";
    $("#logCount").textContent = "(0)";
    $("#die").textContent = "?";
    $("#die").classList.remove("rolling");
    $("#dieName").textContent = "等待掷骰";
    $("#prompt").textContent = "选择人数，掷骰开局。";
    $("#actions").innerHTML = "";
    $("#roundLabel").textContent = "第 1 轮";
    $("#turnLabel").textContent = "等待开局";
    $("#danceLabel").classList.add("hidden");
    renderSetup();
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    if (!game) return;
    const s = game.state;
    const cur = game.current();

    $("#roundLabel").textContent = "第 " + s.round + " 轮";
    $("#turnLabel").textContent = s.winner
      ? "胜者：" + s.winner.name
      : cur
      ? "当前：" + cur.name + " · " + ID[cur.identity]
      : "";

    if (s.lastDance && !s.winner) {
      $("#danceLabel").classList.remove("hidden");
      const r = Math.min(3, Math.floor(s.lastDanceTurns / 2) + 1);
      $("#danceLabel").textContent = "最后一舞 " + r + "/3";
    } else {
      $("#danceLabel").classList.add("hidden");
    }

    renderPlayers();
    renderDie();
    renderPrompt();
    renderActions();
    renderLog();
  }

  function renderPlayers() {
    const s = game.state;
    const wrap = $("#players");
    wrap.innerHTML = "";

    s.players.forEach((p) => {
      const targetable =
        s.phase === "target" && s.pending && s.pending.valid.includes(p.id);
      const card = document.createElement("div");
      card.className =
        "player" +
        (p === game.current() && !s.winner ? " current" : "") +
        (!p.alive ? " dead" : "") +
        (targetable ? " targetable" : "");

      const pct = Math.max(0, Math.min(100, (100 * p.hp) / Math.max(1, p.maxHp)));
      card.innerHTML =
        '<div class="player-top">' +
        '<span class="seat">P' + p.seat + "</span>" +
        '<span class="pname">' + esc(p.name) + "</span>" +
        '<span class="ident">' + ID[p.identity] + "</span>" +
        "</div>" +
        '<div class="hpbar">' +
        '<div class="hpfill" style="width:' + pct + '%"></div>' +
        '<span class="hptext">' + p.hp + " / " + p.maxHp + "</span>" +
        "</div>" +
        '<div class="chips">' + chips(p) + "</div>" +
        (targetable ? '<div class="pick">点击选择目标</div>' : "");

      if (targetable) {
        card.addEventListener("click", () => {
          game.selectTarget(p.id);
          render();
        });
      }
      wrap.appendChild(card);
    });
  }

  function chips(p) {
    const out = [];
    if (!p.alive) out.push('<span class="chip dmg">已倒下</span>');
    if (p.poison) out.push('<span class="chip dmg">毒 ' + p.poison.turns + "</span>");
    if (p.blades) out.push('<span class="chip gold">刃 ' + p.blades + "</span>");
    if (p.ammo) out.push('<span class="chip info">弹 ' + p.ammo + "</span>");
    if (p.hunterAmmo) out.push('<span class="chip info">猎枪 ' + p.hunterAmmo + "</span>");
    if (p.charge) out.push('<span class="chip gold">电 ' + p.charge + "</span>");
    if (p.dodge) out.push('<span class="chip heal">闪 ' + p.dodge + "</span>");
    if (p.healLock) out.push('<span class="chip dmg">禁疗 ' + p.healLock + "</span>");
    if (p.immune) out.push('<span class="chip heal">免疫 ' + p.immune + "</span>");
    if (p.regen) out.push('<span class="chip heal">再生 ' + p.regen + "</span>");
    if (p.stunned) out.push('<span class="chip dmg">眩晕</span>');
    if (p.lifesteal) out.push('<span class="chip heal">吸血</span>');
    if (p.duels) out.push('<span class="chip">拼点 ' + p.duels + "</span>");
    if (p.revived) out.push('<span class="chip">已复活</span>');
    if (p.identity === 6) out.push('<span class="chip info">回复CD ' + p.healCd + "</span>");
    return out.join("");
  }

  function renderDie() {
    const s = game.state;
    const die = $("#die");
    if (s.lastRoll) {
      die.textContent = s.lastRoll.face;
      $("#dieName").textContent = s.lastRoll.face + " · " + FACE_NAMES[s.lastRoll.face];
    } else {
      die.textContent = "?";
      $("#dieName").textContent = "等待掷骰";
    }
  }

  function renderPrompt() {
    const s = game.state;
    const p = game.current();
    let txt = "";
    if (s.winner) {
      txt = s.winner.name + "（" + ID[s.winner.identity] + "）获胜！";
    } else if (s.phase === "roll") {
      txt = "轮到 " + p.name + "，掷行动骰。";
    } else if (s.phase === "target") {
      txt = p.name + " 需要选择目标：" + (TARGET_LABEL[s.pending.kind] || "目标") + "。";
    } else if (s.phase === "action") {
      txt = p.name + " 的自由行动：可以用刃/电/神之刃/猎枪，或结束回合。";
    } else if (s.phase === "end") {
      txt = "射击结束回合。";
    } else if (s.phase === "chargeChoice") {
      txt = "电量：选择“造成 2 伤害”或“回复 2 HP”。";
    } else if (s.phase === "stunned") {
      txt = p.name + " 被眩晕，跳过本回合。";
    }
    $("#prompt").textContent = txt;
  }

  function renderActions() {
    const s = game.state;
    const p = game.current();
    const box = $("#actions");
    box.innerHTML = "";

    const add = (label, fn, primary) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (primary) b.className = "primary";
      b.addEventListener("click", fn);
      box.appendChild(b);
    };

    if (s.winner) {
      add("再来一局", showSetup, true);
      return;
    }
    if (s.phase === "roll") {
      add("掷骰", doRoll, true);
      return;
    }
    if (s.phase === "target") return;
    if (s.phase === "chargeChoice") {
      add("造成 2 伤害", () => { game.chooseCharge("damage"); render(); });
      add("回复 2 HP", () => { game.chooseCharge("heal"); render(); });
      return;
    }
    if (s.phase === "stunned") {
      add("跳过", () => { game.endTurn(); render(); }, true);
      return;
    }
    if (s.phase === "end") {
      add("结束回合", () => { game.endTurn(); render(); }, true);
      return;
    }
    if (s.phase === "action") {
      if (p.blades > 0) add("使用刃 (" + p.blades + ")", () => { game.beginBlade(); render(); });
      if (p.identity === 5 && p.divineCd === 0) add("神之刃", () => { game.useDivine(); render(); });
      if (p.identity === 2 && p.hunterCd === 0) add("猎枪 2 伤", () => { game.useHunterGun(); render(); });
      if (p.identity === 6 && p.healCd === 0) add("随机回复 1d6", () => { game.useHealAction(); render(); });
      if (p.charge >= 2) add("用电回血 (" + p.charge * 2 + ")", () => { game.spendCharge(); render(); });
      add("结束回合", () => { game.endTurn(); render(); }, true);
    }
  }

  async function doRoll() {
    if (busy || !game || game.state.phase !== "roll") return;
    busy = true;
    const die = $("#die");
    die.classList.add("rolling");
    const timer = setInterval(() => {
      die.textContent = 1 + Math.floor(Math.random() * 6);
    }, 60);
    await new Promise((r) => setTimeout(r, 450));
    clearInterval(timer);
    die.classList.remove("rolling");
    if (!game) { busy = false; return; }
    game.roll();
    busy = false;
    render();
  }

  function renderLog() {
    const box = $("#log");
    const entries = game.state.log;
    box.innerHTML = entries
      .map((e) => '<div class="entry ' + e.cls + '"><span class="rd">R' + e.round + "</span>" + esc(e.msg) + "</div>")
      .join("");
    box.scrollTop = box.scrollHeight;
    $("#logCount").textContent = "(" + entries.length + ")";
  }
})();

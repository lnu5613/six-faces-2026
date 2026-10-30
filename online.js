/* 《六面》v1.4 联机客户端（服务器权威，客户端只发 intent） */
(function () {
  "use strict";

  const ID = { 1: "药师", 2: "猎人", 3: "赌徒", 4: "机器人", 5: "剑圣", 6: "随机生成器" };
  const FACE_NAMES = {
    1: "劣质毒药", 2: "骰子霰弹枪", 3: "金质骰子",
    4: "电量炸弹", 5: "骰利刃", 6: "随机生成器",
  };
  const TARGET_LABEL = {
    poison: "下毒目标", shotgun: "射击目标", random: "改 HP 目标",
    blade: "刃击目标", chargeDamage: "2 伤目标", hunterShot: "猎枪目标",
    divine: "神之刃目标", hunterGun: "猎枪目标",
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let session = "";
  let myName = "";
  let roomCode = "";
  let isHost = false;
  let started = false;
  let state = null;
  let deadline = 0;
  let es = null;
  let helloed = false;
  let helloTimer = null;
  let toastTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    session = sessionStorage.getItem("dice6.session") || "";
    myName = sessionStorage.getItem("dice6.name") || "";
    roomCode = (new URLSearchParams(location.search).get("room") || "").toUpperCase();

    $("#playerName").value = myName || "玩家" + Math.floor(Math.random() * 90 + 10);
    $("#roomCode").value = roomCode;

    $("#createBtn").addEventListener("click", createRoom);
    $("#joinBtn").addEventListener("click", joinRoom);
    $("#startBtn").addEventListener("click", startGame);
    $("#copyBtn").addEventListener("click", copyInvite);
    $("#leaveBtn").addEventListener("click", leave);
    $("#leaveGameBtn").addEventListener("click", leave);
    $("#rulesBtn").addEventListener("click", () => $("#rules").classList.remove("hidden"));
    $("#closeRules").addEventListener("click", () => $("#rules").classList.add("hidden"));
    $("#rules").addEventListener("click", (e) => {
      if (e.target === $("#rules")) $("#rules").classList.add("hidden");
    });
    $("#roomCode").addEventListener("input", (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    });
    $("#roomCode").addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinRoom();
    });
    $("#playerName").addEventListener("keydown", (e) => {
      if (e.key === "Enter") createRoom();
    });

    setInterval(updateTimer, 250);

    if (session) {
      showWaiting("正在重连…");
      connect();
    } else {
      showLobby();
      // 开发/截图用：?demo=1 自动创建房间
      if (new URLSearchParams(location.search).get("demo") === "1") {
        $("#playerName").value = "测试玩家";
        setTimeout(createRoom, 100);
      }
    }
  }

  /* ---------------- 网络 ---------------- */
  async function api(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(j.error || "请求失败 " + r.status);
    return j;
  }

  function connect() {
    if (es) {
      try { es.close(); } catch (e) {}
    }
    helloed = false;
    clearTimeout(helloTimer);
    setConn("连接中…", false);

    es = new EventSource("/api/events?session=" + encodeURIComponent(session));
    es.onopen = () => setConn("在线", true);
    es.onmessage = (ev) => {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handle(m);
    };
    es.onerror = () => setConn("重连中…", false);

    helloTimer = setTimeout(() => {
      if (!helloed) {
        clearSession();
        showLobby("会话已失效，请重新创建/加入房间。");
      }
    }, 2500);
  }

  function handle(m) {
    if (m.type === "hello") {
      helloed = true;
      clearTimeout(helloTimer);
      myName = m.name;
      roomCode = m.code;
      isHost = !!m.host;
      setConn("在线", true);
      if (m.started) showGame();
      else showWaiting("等待房主开始…");
    } else if (m.type === "lobby") {
      roomCode = m.code;
      isHost = m.host === session;
      if (!m.started) {
        state = null;
        deadline = 0;
        started = false;
        renderLobby(m);
        showWaiting();
      }
      // 游戏进行中的 lobby 广播（例如有人重连）不打断当前画面
    } else if (m.type === "started") {
      started = true;
      showGame();
    } else if (m.type === "snapshot") {
      state = m.state;
      deadline = m.deadline || 0;
      started = true;
      showGame();
      render();
    } else if (m.type === "error") {
      toast(m.message || "服务器错误");
    }
  }

  async function createRoom() {
    const name = ($("#playerName").value || "").trim();
    try {
      const r = await api("/api/create", { name });
      applySession(r);
    } catch (e) {
      $("#lobbyMsg").textContent = e.message;
    }
  }

  async function joinRoom() {
    const code = ($("#roomCode").value || "").trim().toUpperCase();
    const name = ($("#playerName").value || "").trim();
    if (code.length !== 4) {
      $("#lobbyMsg").textContent = "请输入 4 位房间码。";
      return;
    }
    try {
      const r = await api("/api/join", { code, name });
      applySession(r);
    } catch (e) {
      $("#lobbyMsg").textContent = e.message;
    }
  }

  function applySession(r) {
    session = r.session;
    myName = r.name;
    roomCode = r.code;
    isHost = !!r.host;
    sessionStorage.setItem("dice6.session", session);
    sessionStorage.setItem("dice6.name", myName);
    showWaiting("正在加入房间…");
    connect();
  }

  async function startGame() {
    try {
      await api("/api/start", { session });
    } catch (e) {
      $("#waitMsg").textContent = e.message;
    }
  }

  async function send(action, extra) {
    if (!session) return;
    try {
      await api("/api/intent", Object.assign({ session, action }, extra || {}));
    } catch (e) {
      toast(e.message);
    }
  }

  async function restart() {
    try {
      await api("/api/restart", { session });
    } catch (e) {
      toast(e.message);
    }
  }

  function leave() {
    if (es) {
      try { es.close(); } catch (e) {}
    }
    clearSession();
    location.href = "/";
  }

  function clearSession() {
    session = "";
    myName = "";
    roomCode = "";
    isHost = false;
    started = false;
    state = null;
    deadline = 0;
    sessionStorage.removeItem("dice6.session");
    sessionStorage.removeItem("dice6.name");
    if (es) {
      try { es.close(); } catch (e) {}
      es = null;
    }
  }

  function copyInvite() {
    const link = location.origin + "/?room=" + encodeURIComponent(roomCode);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link)
        .then(() => toast("邀请链接已复制"))
        .catch(() => toast(link));
    } else {
      toast(link);
    }
  }

  /* ---------------- 画面切换 ---------------- */
  function showLobby(msg) {
    $("#lobby").classList.remove("hidden");
    $("#waiting").classList.add("hidden");
    $("#gameApp").classList.add("hidden");
    if (msg) $("#lobbyMsg").textContent = msg;
  }

  function showWaiting(msg) {
    $("#lobby").classList.add("hidden");
    $("#waiting").classList.remove("hidden");
    $("#gameApp").classList.add("hidden");
    $("#roomCodeLabel").textContent = roomCode || "----";
    if (msg) $("#waitMsg").textContent = msg;
  }

  function showGame() {
    $("#lobby").classList.add("hidden");
    $("#waiting").classList.add("hidden");
    $("#gameApp").classList.remove("hidden");
  }

  function renderLobby(m) {
    $("#roomCodeLabel").textContent = m.code;
    $("#roomFoot").textContent = "房间 " + m.code;

    const list = $("#lobbyPlayers");
    list.innerHTML = "";
    m.players.forEach((p) => {
      const row = document.createElement("div");
      row.className = "lobby-row";
      row.innerHTML =
        '<span class="dot ' + (p.connected ? "on" : "") + '"></span>' +
        '<span>' + esc(p.name) + (p.name === myName ? "（你）" : "") + "</span>";
      if (p.name === m.hostName) {
        const tag = document.createElement("span");
        tag.className = "host";
        tag.textContent = "房主";
        row.appendChild(tag);
      }
      list.appendChild(row);
    });

    const canStart = isHost && m.players.length >= 2;
    $("#startBtn").disabled = !canStart;
    $("#startBtn").textContent = isHost
      ? (m.players.length >= 2 ? "开始游戏" : "至少需要 2 人")
      : "等待房主开始";
    $("#waitMsg").textContent = isHost
      ? (m.players.length >= 2 ? "你是房主，可以开始了。" : "再等 " + (2 - m.players.length) + " 位玩家。")
      : "等待房主开始…";
  }

  /* ---------------- 游戏渲染 ---------------- */
  function current() {
    if (!state || !state.players) return null;
    return state.players[state.turnIdx] || null;
  }

  function isMyTurn() {
    const p = current();
    return !!(p && p.name === myName);
  }

  function render() {
    if (!state) {
      $("#prompt").textContent = "等待服务器…";
      return;
    }
    const p = current();
    $("#roundLabel").textContent = "第 " + state.round + " 轮";
    $("#turnLabel").textContent = state.winner
      ? "胜者：" + state.winner.name
      : p ? "当前：" + p.name + " · " + ID[p.identity] : "";
    $("#roomFoot").textContent = "房间 " + roomCode;

    if (state.lastDance && !state.winner) {
      $("#danceLabel").classList.remove("hidden");
      $("#danceLabel").textContent = "最后一舞 " + Math.min(3, Math.floor(state.lastDanceTurns / 2) + 1) + "/3";
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
    const wrap = $("#players");
    wrap.innerHTML = "";
    if (!state) return;

    state.players.forEach((p) => {
      const targetable =
        isMyTurn() && state.phase === "target" && state.pending && state.pending.valid.includes(p.id);
      const card = document.createElement("div");
      card.className =
        "player" +
        (p === current() && !state.winner ? " current" : "") +
        (p.name === myName ? " me" : "") +
        (!p.alive ? " dead" : "") +
        (targetable ? " targetable" : "");

      const pct = Math.max(0, Math.min(100, (100 * p.hp) / Math.max(1, p.maxHp)));
      card.innerHTML =
        '<div class="player-top">' +
        '<span class="seat">P' + p.seat + "</span>" +
        '<span class="pname">' + esc(p.name) + (p.name === myName ? "（你）" : "") + "</span>" +
        '<span class="ident">' + ID[p.identity] + "</span>" +
        "</div>" +
        '<div class="hpbar">' +
        '<div class="hpfill" style="width:' + pct + '%"></div>' +
        '<span class="hptext">' + p.hp + " / " + p.maxHp + "</span>" +
        "</div>" +
        '<div class="chips">' + chips(p) + "</div>" +
        (targetable ? '<div class="pick">点击选择目标</div>' : "");

      if (targetable) {
        card.addEventListener("click", () => send("target", { id: p.id }));
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
    if (!state) return;
    const die = $("#die");
    if (state.lastRoll) {
      die.textContent = state.lastRoll.face;
      $("#dieName").textContent = state.lastRoll.face + " · " + FACE_NAMES[state.lastRoll.face];
    } else {
      die.textContent = "?";
      $("#dieName").textContent = "等待掷骰";
    }
  }

  function renderPrompt() {
    const p = current();
    let txt = "";
    if (!state) {
      txt = "等待服务器…";
    } else if (state.winner) {
      txt = state.winner.name + "（" + ID[state.winner.identity] + "）获胜！";
    } else if (!isMyTurn()) {
      txt = "等待 " + (p ? p.name : "其他玩家") + " 行动…";
    } else if (state.phase === "roll") {
      txt = "轮到你了，掷行动骰。";
    } else if (state.phase === "target") {
      txt = "选择目标：" + (TARGET_LABEL[state.pending.kind] || "目标") + "。";
    } else if (state.phase === "action") {
      txt = "你的自由行动：可以用刃/电/神之刃/猎枪，或结束回合。";
    } else if (state.phase === "end") {
      txt = "射击结束回合。";
    } else if (state.phase === "chargeChoice") {
      txt = "电量：选择“造成 2 伤害”或“回复 2 HP”。";
    } else if (state.phase === "stunned") {
      txt = "你被眩晕，跳过本回合。";
    }
    $("#prompt").textContent = txt;
  }

  function renderActions() {
    const box = $("#actions");
    box.innerHTML = "";
    if (!state) return;

    const p = current();
    const mine = isMyTurn();

    const add = (label, fn, primary, disabled) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (primary) b.className = "primary";
      b.disabled = !!disabled;
      if (!disabled) b.addEventListener("click", fn);
      box.appendChild(b);
      return b;
    };
    const wait = () => add("等待 " + (p ? p.name : "…"), () => {}, false, true);

    if (state.winner) {
      if (isHost) add("再来一局", restart, true);
      else add("等待房主重开", () => {}, false, true);
      return;
    }
    if (!mine) {
      wait();
      return;
    }

    if (state.phase === "roll") {
      add("掷骰", () => send("roll"), true);
      return;
    }
    if (state.phase === "target") return;
    if (state.phase === "chargeChoice") {
      add("造成 2 伤害", () => send("charge", { choice: "damage" }));
      add("回复 2 HP", () => send("charge", { choice: "heal" }));
      return;
    }
    if (state.phase === "stunned") {
      add("跳过", () => send("endTurn"), true);
      return;
    }
    if (state.phase === "end") {
      add("结束回合", () => send("endTurn"), true);
      return;
    }
    if (state.phase === "action") {
      if (p.blades > 0) add("使用刃 (" + p.blades + ")", () => send("blade"));
      if (p.identity === 5 && p.divineCd === 0) add("神之刃", () => send("divine"));
      if (p.identity === 2 && p.hunterCd === 0) add("猎枪 2 伤", () => send("hunterGun"));
      if (p.identity === 6 && p.healCd === 0) add("随机回复 1d6", () => send("healAction"));
      if (p.charge >= 2) add("用电回血 (" + p.charge * 2 + ")", () => send("spendCharge"));
      add("结束回合", () => send("endTurn"), true);
    }
  }

  function renderLog() {
    if (!state) return;
    const box = $("#log");
    box.innerHTML = state.log
      .map((e) => '<div class="entry ' + e.cls + '"><span class="rd">R' + e.round + "</span>" + esc(e.msg) + "</div>")
      .join("");
    box.scrollTop = box.scrollHeight;
    $("#logCount").textContent = "(" + state.log.length + ")";
  }

  function updateTimer() {
    const el = $("#timerLabel");
    if (!started || !deadline || (state && state.phase === "gameover")) {
      el.textContent = "—";
      el.classList.remove("timer-hot");
      return;
    }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = left + "s";
    el.classList.toggle("timer-hot", left <= 5);
  }

  function setConn(text, ok) {
    const el = $("#connLabel");
    el.textContent = text;
    el.classList.toggle("conn-ok", !!ok);
    el.classList.toggle("conn-bad", !ok);
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }
})();

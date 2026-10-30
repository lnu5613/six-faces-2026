#!/usr/bin/env node
/*
 * 《六面》v1.4 联机试玩服务器
 * - 零依赖：http + SSE + fetch POST
 * - 服务器权威：客户端只发 intent，不掷骰
 * - 房间制：4 位邀请码，2~6 人，30 秒回合计时
 *
 *   node server.js
 *   打开 http://127.0.0.1:8788/
 *
 * 环境变量：
 *   PORT=8788        端口
 *   TURN_MS=30000    每步超时毫秒
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("./engine.js");
const { Game } = globalThis.DiceGame;

const PORT = Number(process.env.PORT || 8788);
const TURN_MS = Number(process.env.TURN_MS || 30000);
const ROOT = __dirname;

const rooms = new Map();      // code -> room
const sessions = new Map();   // sessionId -> {id, room, name, res, connected}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
const now = () => Date.now();

function cleanName(n) {
  return String(n || "")
    .replace(/[<>&"']/g, "")
    .trim()
    .slice(0, 12) || "玩家";
}

function uniqueName(room, name) {
  const base = cleanName(name);
  let candidate = base;
  let i = 2;
  while (room.names.includes(candidate)) candidate = base + "#" + i++;
  return candidate;
}

function code4() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let tries = 0; tries < 1000; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error("no room code");
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */
function sseSend(sess, msg) {
  if (!sess || !sess.res) return;
  try {
    sess.res.write("data: " + JSON.stringify(msg) + "\n\n");
  } catch (e) {
    sess.res = null;
    sess.connected = false;
  }
}

function broadcast(room, msg) {
  for (const sid of room.sessions) sseSend(sessions.get(sid), msg);
}

function lobbyPayload(room) {
  const host = sessions.get(room.hostSession);
  return {
    type: "lobby",
    code: room.code,
    host: room.hostSession,
    hostName: host ? host.name : null,
    started: room.started,
    players: room.sessions.map((sid) => {
      const s = sessions.get(sid);
      return { name: s ? s.name : "?", connected: !!(s && s.connected) };
    }),
  };
}

function broadcastLobby(room) {
  broadcast(room, lobbyPayload(room));
}

function broadcastSnapshot(room) {
  broadcast(room, {
    type: "snapshot",
    code: room.code,
    seq: room.seq,
    deadline: room.deadline,
    state: room.game ? room.game.state : null,
  });
}

/* ------------------------------------------------------------------ */
/* 计时器 / 自动行动                                                    */
/* ------------------------------------------------------------------ */
function afterAction(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;

  if (!room.game) {
    room.deadline = 0;
    broadcastLobby(room);
    return;
  }

  const st = room.game.state;
  if (st.phase === "gameover" || st.winner) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    room.turnKey = "";
    room.timerKey = "";
    room.deadline = 0;
    broadcastSnapshot(room);
    return;
  }

  // 计时按“整个回合”算：同一玩家的 roll/target/action 不重置 30 秒
  const key = st.round + ":" + st.turnIdx;
  if (room.turnKey !== key) {
    if (room.timer) clearTimeout(room.timer);
    room.turnKey = key;
    room.timerKey = key;
    room.deadline = now() + TURN_MS;
    room.timer = setTimeout(() => {
      if (room.timerKey === key) autoPlay(room);
    }, TURN_MS);
  } else if (!room.timer) {
    const left = Math.max(500, room.deadline - now());
    room.timerKey = key;
    room.timer = setTimeout(() => {
      if (room.timerKey === key) autoPlay(room);
    }, left);
  }

  broadcastSnapshot(room);
}

function autoPlay(room) {
  room.timer = null;
  if (room.timerKey !== room.turnKey) return; // 旧计时器，已被新回合取代
  const g = room.game;
  if (!g) return;

  try {
    let guard = 0;
    while (guard++ < 20 && g.state.phase !== "gameover") {
      const st = g.state;
      const p = st.players[st.turnIdx];
      if (!p) break;

      if (st.phase === "roll") {
        g.roll();
        continue;
      }
      if (st.phase === "target") {
        const targets = st.pending.valid
          .map((id) => g.byId(id))
          .filter((x) => x && x.alive)
          .sort((a, b) => a.hp - b.hp);
        if (targets.length) g.selectTarget(targets[0].id);
        continue;
      }
      if (st.phase === "chargeChoice") {
        g.chooseCharge(p.hp <= 8 ? "heal" : "damage");
        continue;
      }
      if (st.phase === "action" || st.phase === "end" || st.phase === "stunned") {
        g.endTurn();
        break;
      }
      break;
    }
  } catch (e) {
    console.error("autoPlay error:", e);
  }

  room.seq++;
  afterAction(room);
}

/* ------------------------------------------------------------------ */
/* 房间                                                                */
/* ------------------------------------------------------------------ */
function newRoom(hostSession) {
  const room = {
    code: code4(),
    hostSession,
    sessions: [],
    names: [],
    started: false,
    game: null,
    timer: null,
    deadline: 0,
    turnKey: "",
    timerKey: "",
    seq: 0,
    createdAt: now(),
    lastActivity: now(),
  };
  rooms.set(room.code, room);
  return room;
}

function maybeReassignHost(room) {
  if (room.started) return;
  const host = sessions.get(room.hostSession);
  if (host && host.connected) return;
  const next = room.sessions
    .map((sid) => sessions.get(sid))
    .find((s) => s && s.connected);
  if (next) {
    room.hostSession = next.id;
    broadcastLobby(room);
  }
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
async function handleCreate(req, res) {
  const body = await readBody(req);
  const sessionId = crypto.randomUUID();
  const room = newRoom(sessionId);
  const name = uniqueName(room, body.name);
  room.sessions.push(sessionId);
  room.names.push(name);
  sessions.set(sessionId, {
    id: sessionId,
    room: room.code,
    name,
    res: null,
    connected: false,
  });
  console.log(`[room ${room.code}] create by ${name}`);
  json(res, 200, { session: sessionId, name, code: room.code, host: true });
}

async function handleJoin(req, res) {
  const body = await readBody(req);
  const code = String(body.code || "").trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return json(res, 404, { error: "房间不存在" });
  if (room.started) return json(res, 409, { error: "游戏已经开始" });
  if (room.sessions.length >= 6) return json(res, 409, { error: "房间已满" });

  const sessionId = crypto.randomUUID();
  const name = uniqueName(room, body.name);
  room.sessions.push(sessionId);
  room.names.push(name);
  sessions.set(sessionId, {
    id: sessionId,
    room: room.code,
    name,
    res: null,
    connected: false,
  });
  console.log(`[room ${room.code}] join ${name}`);
  broadcastLobby(room);
  json(res, 200, { session: sessionId, name, code: room.code, host: false });
}

async function handleStart(req, res) {
  const body = await readBody(req);
  const sess = sessions.get(body.session);
  if (!sess) return json(res, 401, { error: "会话失效" });
  const room = rooms.get(sess.room);
  if (!room) return json(res, 404, { error: "房间不存在" });
  if (room.hostSession !== sess.id) return json(res, 403, { error: "只有房主能开始" });
  if (room.started) return json(res, 409, { error: "已经开始了" });
  if (room.sessions.length < 2) return json(res, 409, { error: "至少需要 2 人" });

  room.game = new Game(room.names);
  room.started = true;
  room.seq++;
  console.log(`[room ${room.code}] start with ${room.names.length} players`);
  broadcast(room, { type: "started", code: room.code });
  afterAction(room);
  json(res, 200, { ok: true });
}

async function handleIntent(req, res) {
  const body = await readBody(req);
  const sess = sessions.get(body.session);
  if (!sess) return json(res, 401, { error: "会话失效" });
  const room = rooms.get(sess.room);
  if (!room || !room.started || !room.game) {
    return json(res, 409, { error: "游戏还没开始" });
  }

  const g = room.game;
  const st = g.state;
  if (st.phase === "gameover") return json(res, 409, { error: "游戏已结束" });

  const cur = st.players[st.turnIdx];
  if (!cur || cur.name !== sess.name) {
    return json(res, 409, { error: "还没轮到你" });
  }

  try {
    switch (body.action) {
      case "roll": g.roll(); break;
      case "target": g.selectTarget(Number(body.id)); break;
      case "charge": g.chooseCharge(body.choice === "heal" ? "heal" : "damage"); break;
      case "blade": g.beginBlade(); break;
      case "divine": g.useDivine(); break;
      case "hunterGun": g.useHunterGun(); break;
      case "healAction": g.useHealAction(); break;
      case "spendCharge": g.spendCharge(); break;
      case "endTurn": g.endTurn(); break;
      default: return json(res, 400, { error: "未知动作" });
    }
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  room.seq++;
  room.lastActivity = now();
  afterAction(room);
  json(res, 200, { ok: true, seq: room.seq });
}

async function handleRestart(req, res) {
  const body = await readBody(req);
  const sess = sessions.get(body.session);
  if (!sess) return json(res, 401, { error: "会话失效" });
  const room = rooms.get(sess.room);
  if (!room) return json(res, 404, { error: "房间不存在" });
  if (room.hostSession !== sess.id) {
    const host = sessions.get(room.hostSession);
    if (host && host.connected) {
      return json(res, 403, { error: "只有房主能重开" });
    }
    room.hostSession = sess.id; // 房主已掉线，交给当前玩家
  }

  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.game = null;
  room.started = false;
  room.deadline = 0;
  room.turnKey = "";
  room.timerKey = "";
  room.seq = 0;
  broadcastLobby(room);
  json(res, 200, { ok: true });
}

function handleEvents(req, res, url) {
  const sessionId = url.searchParams.get("session");
  const sess = sessions.get(sessionId);
  if (!sess) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("invalid session");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (res.socket) res.socket.setNoDelay(true);
  res.write("retry: 2000\n\n");

  if (sess.res) {
    try { sess.res.end(); } catch (e) {}
  }
  sess.res = res;
  sess.connected = true;

  const room = rooms.get(sess.room);
  if (room) maybeReassignHost(room);

  sseSend(sess, {
    type: "hello",
    name: sess.name,
    code: sess.room,
    host: !!(room && room.hostSession === sess.id),
    started: !!(room && room.started),
  });

  if (room) {
    if (room.started && room.game) {
      sseSend(sess, {
        type: "snapshot",
        code: room.code,
        seq: room.seq,
        deadline: room.deadline,
        state: room.game.state,
      });
    }
    broadcastLobby(room);
  }

  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (e) {}
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    if (sess.res === res) {
      sess.res = null;
      sess.connected = false;
    }
    if (room) {
      broadcastLobby(room);
      maybeReassignHost(room);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(res, pathname) {
  let p = pathname === "/" ? "/online.html" : pathname;
  let file = path.resolve(ROOT, "." + p);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const p = url.pathname;

  try {
    if (p === "/api/create" && req.method === "POST") return await handleCreate(req, res);
    if (p === "/api/join" && req.method === "POST") return await handleJoin(req, res);
    if (p === "/api/start" && req.method === "POST") return await handleStart(req, res);
    if (p === "/api/intent" && req.method === "POST") return await handleIntent(req, res);
    if (p === "/api/restart" && req.method === "POST") return await handleRestart(req, res);
    if (p === "/api/events" && req.method === "GET") return handleEvents(req, res, url);
    if (p === "/api/health") return json(res, 200, { ok: true, rooms: rooms.size });
    if (p.startsWith("/api/")) return json(res, 404, { error: "not found" });
    return serveStatic(res, p);
  } catch (e) {
    console.error("request error:", e);
    if (!res.headersSent) json(res, 500, { error: "server error" });
    else res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`六面 online: http://127.0.0.1:${PORT}/  (turn ${TURN_MS}ms)`);
});

// 云平台/容器优雅退出
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// 定期清理空房间
setInterval(() => {
  const cutoff = now() - 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    const anyConnected = room.sessions.some((sid) => {
      const s = sessions.get(sid);
      return s && s.connected;
    });
    if (!anyConnected && room.lastActivity < cutoff) {
      if (room.timer) clearTimeout(room.timer);
      rooms.delete(code);
      for (const sid of room.sessions) sessions.delete(sid);
      console.log(`[room ${code}] cleaned`);
    }
  }
}, 60000);

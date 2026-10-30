/*
 * 联机服务器冒烟测试：3 个 Node 机器人开房、加入、开始、自动打完一局。
 * 需要先启动 server.js（默认 8788）。
 *
 *   node test_online.js
 */
const http = require("http");
const https = require("https");

const BASE = process.env.BASE || "http://127.0.0.1:8788";
const SSE_LIB = BASE.startsWith("https:") ? https : http;

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(path + " " + r.status + " " + JSON.stringify(j));
  return j;
}

function openSSE(session, onMsg) {
  return new Promise((resolve, reject) => {
    const req = SSE_LIB.get(
      BASE + "/api/events?session=" + encodeURIComponent(session),
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error("SSE status " + res.statusCode));
          return;
        }
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = block.split("\n").filter((l) => l.startsWith("data:"));
            if (!lines.length) continue;
            const data = lines.map((l) => l.slice(5).trim()).join("\n");
            if (!data) continue;
            try { onMsg(JSON.parse(data)); } catch (e) {
              console.error("bad sse json", e, data);
            }
          }
        });
        resolve(req);
      }
    );
    req.on("error", reject);
  });
}

async function maybeAct(c) {
  const s = c.state;
  if (!s || s.phase === "gameover" || c.acting) return;
  const cur = s.players[s.turnIdx];
  if (!cur || cur.name !== c.name) return;

  const seq = c.seq;
  c.acting = true;
  try {
    if (s.phase === "roll") {
      await post("/api/intent", { session: c.session, action: "roll" });
    } else if (s.phase === "target") {
      const targets = s.pending.valid
        .map((id) => s.players.find((p) => p.id === id))
        .filter(Boolean)
        .sort((a, b) => a.hp - b.hp);
      await post("/api/intent", { session: c.session, action: "target", id: targets[0].id });
    } else if (s.phase === "chargeChoice") {
      await post("/api/intent", { session: c.session, action: "charge", choice: "heal" });
    } else if (s.phase === "action" || s.phase === "end" || s.phase === "stunned") {
      await post("/api/intent", { session: c.session, action: "endTurn" });
    }
  } catch (e) {
    console.error("bot action error", c.name, e.message);
  } finally {
    c.acting = false;
    // 如果 POST 返回前已经来了新 snapshot，补一次；否则等下一个 snapshot
    if (c.seq > seq) setTimeout(() => maybeAct(c), 120);
  }
}

async function main() {
  const N = Math.max(2, Math.min(6, Number(process.argv[2] || 3)));
  console.log("create + join...");
  const a = await post("/api/create", { name: "A" });
  const list = [a];
  const names = ["A", "B", "C", "D", "E", "F"];
  for (let i = 1; i < N; i++) {
    list.push(await post("/api/join", { code: a.code, name: names[i] }));
  }
  console.log("room", a.code, "players", list.map((x) => x.name).join(", "));

  const clients = list.map((x) => ({
    session: x.session,
    name: x.name,
    state: null,
    seq: 0,
    acting: false,
    req: null,
  }));

  let finished = 0;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  for (const cl of clients) {
    cl.req = await openSSE(cl.session, (msg) => {
      if (msg.type === "snapshot") {
        cl.state = msg.state;
        cl.seq = msg.seq;
        if (msg.state.phase === "gameover") {
          finished++;
          if (finished === clients.length) resolveDone();
          return;
        }
        maybeAct(cl);
      }
    });
  }

  await new Promise((r) => setTimeout(r, 300));

  console.log("start...");
  await post("/api/start", { session: a.session });

  await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error("game timeout")), 60000)),
  ]);

  const final = clients[0].state;
  console.log("game over. round", final.round, "winner", final.winner && final.winner.name);
  console.log("winner identity", final.winner && final.winner.identity);
  console.log("log entries", final.log.length);

  // 重开测试
  console.log("restart...");
  await post("/api/restart", { session: a.session });
  await new Promise((r) => setTimeout(r, 250));

  for (const cl of clients) {
    if (cl.req) cl.req.destroy();
  }
  console.log("ONLINE SMOKE TEST OK");
  process.exit(0);
}

main().catch((e) => {
  console.error("ONLINE SMOKE TEST FAILED:", e);
  process.exit(1);
});

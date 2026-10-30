/*
 * 超时自动行动测试：需要 TURN_MS 很短的服务器（示例 700ms）。
 *   PORT=8789 TURN_MS=700 node server.js
 *   node test_timer.js
 */
const http = require("http");
const BASE = process.env.BASE || "http://127.0.0.1:8789";

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + " " + r.status + " " + JSON.stringify(j));
  return j;
}

function openSSE(session, onMsg) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + "/api/events?session=" + encodeURIComponent(session), (res) => {
      if (res.statusCode !== 200) return reject(new Error("SSE " + res.statusCode));
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
          try { onMsg(JSON.parse(lines.map((l) => l.slice(5).trim()).join("\n"))); } catch (e) {}
        }
      });
      resolve(req);
    });
    req.on("error", reject);
  });
}

main().catch((e) => { console.error("TIMER TEST FAILED", e); process.exit(1); });

async function main() {
  const a = await post("/api/create", { name: "T1" });
  const b = await post("/api/join", { code: a.code, name: "T2" });
  const c = await post("/api/join", { code: a.code, name: "T3" });

  let last = null;
  let snapshots = 0;
  const req = await openSSE(a.session, (m) => {
    if (m.type === "snapshot") { last = m.state; snapshots++; }
  });

  await new Promise((r) => setTimeout(r, 250));
  await post("/api/start", { session: a.session });

  // 不发任何 intent，等服务器自动行动
  await new Promise((r) => setTimeout(r, 5000));

  console.log("snapshots", snapshots, "round", last && last.round, "phase", last && last.phase,
    "winner", last && last.winner && last.winner.name);
  console.log("log tail:");
  (last.log || []).slice(-6).forEach((e) => console.log(" ", e.msg));

  if (!last || (last.round < 2 && last.phase !== "gameover")) {
    throw new Error("timer did not advance the game");
  }
  req.destroy();
  console.log("TIMER TEST OK");
  process.exit(0);
}

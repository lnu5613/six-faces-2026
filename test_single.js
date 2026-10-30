/*
 * v1.4 简化单机引擎的无头测试。
 *   node test_single.js
 */
require("./engine_single.js");
const { Game, ID } = globalThis.DiceGame;

function pickTarget(g) {
  const valid = g.state.pending.valid;
  const ts = valid.map((id) => g.byId(id)).filter(Boolean).sort((a, b) => a.hp - b.hp);
  return ts[0].id;
}

function playOne(names) {
  const g = new Game(names);
  let guard = 0;
  while (g.state.phase !== "gameover" && guard++ < 3000) {
    const ph = g.state.phase;
    const p = g.current();
    if (ph === "pre") {
      if (p.identity === 2 && p.hunterCd === 0) g.useHunterGun();
      else if (p.identity === 5 && p.divineCd === 0) g.useDivine();
      else if (p.blades > 0) g.beginBlade();
      else if (p.ammo > 0) g.beginStoredShot();
      else if (p.identity === 6 && p.healCd === 0 && p.hp <= 8) g.useHealAction();
      else g.roll();
    } else if (ph === "target") {
      g.selectTarget(pickTarget(g));
    } else if (ph === "shotgunChoice") {
      g.chooseShotgun("shoot");
    } else if (ph === "end") {
      g.endTurn();
    } else {
      throw new Error("unknown phase " + ph);
    }
  }
  if (g.state.phase !== "gameover") return { stuck: true, g };
  return { stuck: false, g };
}

function run(n, games) {
  const wins = {};
  const rounds = [];
  let stuck = 0;
  const names = Array.from({ length: n }, (_, i) => "P" + (i + 1));
  for (let i = 0; i < games; i++) {
    const r = playOne(names);
    if (r.stuck) {
      stuck++;
      console.log("STUCK", n, r.g.state.phase, r.g.state.players.map((p) => p.name + ":" + p.hp).join(","));
      break;
    }
    rounds.push(r.g.state.round);
    const w = r.g.state.winner;
    if (w) wins[w.identity] = (wins[w.identity] || 0) + 1;
  }
  const avg = rounds.reduce((a, b) => a + b, 0) / Math.max(1, rounds.length);
  console.log(
    `${n}p games=${games} avg rounds=${avg.toFixed(1)} stuck=${stuck} ` +
    Object.keys(wins).sort().map((k) => `${ID[k]}=${(100 * wins[k] / games).toFixed(1)}%`).join(" ")
  );
}

const games = Number(process.argv[2] || 500);
for (const n of [2, 3, 4, 5, 6]) run(n, games);

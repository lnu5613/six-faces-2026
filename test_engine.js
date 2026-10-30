/*
 * 无头测试：用简单 AI 把引擎跑几千局，检查是否会卡死/报错，
 * 并顺便看 v1.4 试玩版的身份胜率与回合数。
 *
 *   node test_engine.js
 */
require("./engine.js");
const { Game, ID } = globalThis.DiceGame;

function chooseTarget(g) {
  const valid = g.state.pending.valid;
  // 简单 AI：优先能补掉的，其次最低血
  const alive = valid.map((id) => g.byId(id)).filter(Boolean);
  alive.sort((a, b) => {
    if (a.hp !== b.hp) return a.hp - b.hp;
    return b.identity - a.identity;
  });
  return alive[0].id;
}

function playOne(names) {
  const g = new Game(names);
  let guard = 0;

  while (g.state.phase !== "gameover" && guard++ < 4000) {
    const ph = g.state.phase;
    const p = g.current();

    if (ph === "roll") {
      g.roll();
    } else if (ph === "target") {
      g.selectTarget(chooseTarget(g));
    } else if (ph === "chargeChoice") {
      g.chooseCharge(p.hp <= 8 ? "heal" : "damage");
    } else if (ph === "action") {
      if (p.blades > 0) {
        g.beginBlade();
      } else if (p.identity === 5 && p.divineCd === 0) {
        g.useDivine();
      } else if (p.identity === 2 && p.hunterCd === 0) {
        g.useHunterGun();
      } else if (p.identity === 6 && p.healCd === 0 && p.hp <= 10) {
        g.useHealAction();
      } else if (p.charge >= 2 && p.hp <= 6) {
        g.spendCharge();
      } else {
        g.endTurn();
      }
    } else if (ph === "end" || ph === "stunned") {
      g.endTurn();
    } else {
      throw new Error("unknown phase: " + ph);
    }
  }

  if (g.state.phase !== "gameover") {
    return { stuck: true, state: g.state };
  }
  return { stuck: false, g };
}

function run(nPlayers, games) {
  const wins = {};
  const rounds = [];
  let stuck = 0;
  const names = Array.from({ length: nPlayers }, (_, i) => "P" + (i + 1));

  for (let i = 0; i < games; i++) {
    const r = playOne(names);
    if (r.stuck) {
      stuck++;
      console.log("STUCK", nPlayers, r.state.phase, r.state.turnIdx, r.state.lastDance,
        r.state.players.map((p) => `${p.name}:${p.hp}:${p.alive}`).join(", "));
      break;
    }
    rounds.push(r.g.state.round);
    const w = r.g.state.winner;
    if (w) wins[w.identity] = (wins[w.identity] || 0) + 1;
  }

  const avg = rounds.reduce((a, b) => a + b, 0) / Math.max(1, rounds.length);
  const parts = Object.keys(wins).sort().map(
    (k) => `${ID[k]}=${(100 * wins[k] / games).toFixed(1)}%`
  );
  console.log(`\n${nPlayers}p  games=${games}  avg rounds=${avg.toFixed(1)}  stuck=${stuck}`);
  console.log("  " + parts.join("  "));
}

const games = Number(process.argv[2] || 3000);
for (const n of [3, 4, 5, 6]) run(n, games);

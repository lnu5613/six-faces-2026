/*
 * 《六面》v1.4 试玩版 —— 规则引擎
 * 无依赖，可直接被浏览器 <script> 引入，也可被 Node require 后跑无头测试。
 *
 * 设计目标：把“骰面=身份”的标准局做成一个 15~25 分钟、2~6 人的可玩原型。
 * 明确不包含：Boss 模式、豪赌模式、隐藏身份、响应窗口。
 * 已包含 v1.4 的关键修正：身份/座次解耦、猎人削弱、机器人 1 次拼点、
 * 面 3/4 增强、炸弹 3 电、最后一舞 3 轮。
 */
(function (global) {
  "use strict";

  const ID = { 1: "药师", 2: "猎人", 3: "赌徒", 4: "机器人", 5: "剑圣", 6: "随机生成器" };

  const d6 = () => 1 + Math.floor(Math.random() * 6);
  const dice = (n) => { let s = 0; for (let i = 0; i < n; i++) s += d6(); return s; };
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  class Game {
    constructor(names) {
      this.state = {
        players: [],
        round: 1,
        turnIdx: 0,
        phase: "roll",          // roll | target | action | end | chargeChoice | stunned | gameover
        pending: null,
        lastDance: false,
        lastDanceTurns: 0,
        winner: null,
        log: [],
        startedWith: names.length,
        lastRoll: null,
        bloodMoonAnnounced: false,
        healTotal: 0,
      };
      this.setup(names);
    }

    /* ---------------- 基础查询 ---------------- */
    log(msg, cls = "") {
      this.state.log.push({ msg, cls, round: this.state.round });
      if (this.state.log.length > 260) this.state.log.shift();
    }
    current() { return this.state.players[this.state.turnIdx]; }
    alive() { return this.state.players.filter((p) => p.alive); }
    enemies(p) { return this.alive().filter((x) => x !== p); }
    byId(id) { return this.state.players.find((p) => p.id === id); }
    prevAlive(p) {
      const n = this.state.players.length;
      for (let k = 1; k < n; k++) {
        const q = this.state.players[(p.id - k + n * 2) % n];
        if (q.alive && q !== p) return q;
      }
      return null;
    }
    nextAlive(p) {
      const n = this.state.players.length;
      for (let k = 1; k < n; k++) {
        const q = this.state.players[(p.id + k) % n];
        if (q.alive && q !== p) return q;
      }
      return null;
    }
    adjacent(t) {
      const a = this.alive();
      const i = a.indexOf(t);
      if (i < 0) return [];
      const out = [];
      for (const k of [-1, 1]) {
        const q = a[(i + k + a.length) % a.length];
        if (q !== t && !out.includes(q)) out.push(q);
      }
      return out;
    }

    /* ---------------- 开局 ---------------- */
    setup(names) {
      const n = names.length;
      let rolls = [];
      for (let tries = 0; tries < 3000; tries++) {
        rolls = names.map(() => d6());
        if (new Set(rolls).size === n) break;
      }
      if (new Set(rolls).size < n) rolls = shuffle([1, 2, 3, 4, 5, 6]).slice(0, n);

      const order = rolls
        .map((r, i) => ({ r, i }))
        .sort((a, b) => b.r - a.r)
        .map((o) => o.i);

      const ids = shuffle([1, 2, 3, 4, 5, 6]).slice(0, n);

      this.state.players = order.map((idx, seat) => {
        const identity = ids[seat];
        const hp = identity === 6 ? dice(4) + 6 : 20;
        return {
          id: seat,
          seat: seat + 1,
          name: names[idx],
          identity,
          hp,
          maxHp: identity === 6 ? 30 : 20,
          alive: true,

          poison: null,
          healLock: 0,
          dmgReduce: 0,
          dodge: 0,
          blades: 0,
          ammo: 0,
          hunterAmmo: 0,
          hunterCd: 0,
          charge: 0,
          duels: identity === 4 ? 1 : identity === 6 ? 2 : 3,
          revived: false,
          regen: 0,
          lifesteal: false,
          stunned: false,
          immune: 0,
          divineCd: 0,
          divineBonus: 0,
          healCd: 0,
          kills: 0,
          damage: 0,
        };
      });

      this.log("掷骰：" + names.map((nm, i) => `${nm}=${rolls[i]}`).join("，"));
      this.log(
        "座次：" + this.state.players
          .map((p) => `P${p.seat} ${p.name}（${ID[p.identity]}，${p.hp}HP）`)
          .join(" → "),
        "turn"
      );
      this.beginTurn();
    }

    /* ---------------- 回合流程 ---------------- */
    beginTurn() {
      if (this.state.winner) return;
      const p = this.current();
      if (!p || !p.alive) { this.advance(); return; }

      this.log(`—— 第 ${this.state.round} 轮 · ${p.name}（${ID[p.identity]}）——`, "turn");

      p.immune = Math.max(0, p.immune - 1);
      p.healLock = Math.max(0, p.healLock - 1);
      p.hunterCd = Math.max(0, p.hunterCd - 1);
      p.divineCd = Math.max(0, p.divineCd - 1);
      p.healCd = Math.max(0, p.healCd - 1);

      if (p.regen > 0) { this.heal(p, 2, p); p.regen--; }

      if (p.poison) {
        const ps = p.poison;
        const dmg = dice(3) + ps.bonus;
        this.damage(null, p, dmg, { debuff: true, canKill: ps.lethal, attack: false });
        ps.turns--;
        if (ps.turns <= 0) p.poison = null;
      }

      if (!p.alive) { this.advance(); return; }
      if (this.state.winner) return;

      if (p.stunned) {
        p.stunned = false;
        this.log(`${p.name} 被眩晕，跳过点数效果`, "bad");
        this.state.phase = "stunned";
        return;
      }

      this.state.pending = null;
      this.state.phase = "roll";
    }

    roll() {
      if (this.state.phase !== "roll") return;
      const p = this.current();
      if (!p || !p.alive) return;
      const raw = d6();
      let face = raw;
      if (p.identity === 4 && raw === 3) face = 4;
      this.state.lastRoll = { raw, face };
      this.log(`${p.name} 掷出 ${raw}${face !== raw ? "（机器人改为 4）" : ""}`, "roll");
      this.resolveFace(face);
    }

    resolveFace(face) {
      const p = this.current();

      if (face === 1) {
        if (p.identity === 1) {
          const es = this.enemies(p);
          if (!es.length) { this.toAction(); return; }
          this.setTarget("poison", es);
        } else {
          const r = d6();
          const t = r % 2 === 0 ? this.prevAlive(p) : this.nextAlive(p);
          if (t) this.applyPoison(p, t);
          this.toAction();
        }
        return;
      }

      if (face === 2) {
        p.ammo = Math.min(2, p.ammo + 1);
        if (p.identity === 5) p.divineBonus += 2;
        this.log(`${p.name} 装填骰子霰弹枪（${p.ammo}/2）`, "info");
        const es = this.enemies(p);
        if (!es.length) { this.toAction(); return; }
        this.setTarget("shotgun", es);
        return;
      }

      if (face === 3) {
        if (p.identity === 1) {
          p.regen = 5;
          this.log(`${p.name} 获得生命回复（5 回合，每回合 2 HP）`, "heal");
          this.toAction();
          return;
        }
        const r = d6();
        if (r % 2 === 0) {
          this.log(`${p.name} 金质骰子：偶数，回复 5 HP`, "heal");
          this.heal(p, 5, p);
        } else {
          this.log(`${p.name} 金质骰子：奇数，对下一位造成 5 伤害`, "dmg");
          const t = this.nextAlive(p);
          if (t) this.damage(p, t, this.gambler(p, 5), { attack: true });
        }
        this.toAction();
        return;
      }

      if (face === 4) {
        p.charge++;
        if (p.identity === 4) this.heal(p, 2, p);
        if (p.charge >= 3) {
          this.bomb(p);
          this.toAction();
        } else {
          this.state.pending = { kind: "charge" };
          this.state.phase = "chargeChoice";
        }
        return;
      }

      if (face === 5) {
        if (p.identity === 2) {
          p.hunterAmmo = Math.min(2, p.hunterAmmo + 1);
          this.log(`${p.name} 装填猎枪（${p.hunterAmmo}/2）`, "info");
          const es = this.enemies(p);
          if (!es.length) { this.toAction(); return; }
          this.setTarget("hunterShot", es);
        } else {
          p.blades = Math.min(3, p.blades + 1);
          this.log(`${p.name} 获得骰利刃（${p.blades}/3）`, "info");
          this.toAction();
        }
        return;
      }

      if (face === 6) {
        if (p.hp <= 5) {
          p.lifesteal = true;
          this.log(`${p.name} 获得吸血：造成伤害时回复一半`, "buff");
          this.toAction();
          return;
        }
        this.setTarget("random", this.alive());
      }
    }

    /* ---------------- 目标选择 ---------------- */
    setTarget(kind, valid, extra) {
      if (!valid || !valid.length) { this.toAction(); return; }
      this.state.pending = Object.assign({ kind, valid: valid.map((x) => x.id) }, extra || {});
      this.state.phase = "target";
    }

    selectTarget(id) {
      const pending = this.state.pending;
      if (!pending || !pending.valid.includes(id)) return;
      const p = this.current();
      const t = this.byId(id);
      if (!t || !t.alive) return;

      if (pending.kind === "poison") {
        this.applyPoison(p, t);
        this.toAction();
        return;
      }

      if (pending.kind === "shotgun") {
        const dmg = this.gambler(p, d6());
        this.damage(p, t, dmg, { attack: true });
        const splash = p.identity === 2 || dmg >= 4;
        if (splash) {
          const adj = this.adjacent(t).filter((x) => x !== p);
          if (adj.length) this.damage(p, adj[0], this.gambler(p, 2), { attack: true });
        }
        if (Math.random() < 0.5 && t.alive) {
          t.stunned = true;
          this.log(`${t.name} 下回合点数效果失效`, "debuff");
        }
        p.ammo = Math.max(0, p.ammo - 1);
        this.toEnd();
        return;
      }

      if (pending.kind === "random") {
        const before = t.hp;
        const v = dice(4);
        t.hp = Math.min(v, t.maxHp);
        this.log(`${p.name} 把 ${t.name} 的 HP 改为 ${t.hp}（4d6=${v}）`, "special");
        if (t.hp < before) p.damage += before - t.hp;
        if (t.hp <= 0) this.onLethal(t, p);
        this.toAction();
        return;
      }

      if (pending.kind === "blade") {
        p.blades = Math.max(0, p.blades - 1);
        if (t.blades > 0) this.damage(p, p, 2, { canKill: false, attack: false });
        this.damage(p, t, 4, { attack: true });
        this.toAction();
        return;
      }

      if (pending.kind === "chargeDamage") {
        this.damage(p, t, 2, { attack: false });
        this.toAction();
        return;
      }

      if (pending.kind === "hunterShot") {
        this.damage(p, t, this.gambler(p, 3), { attack: true });
        const adj = this.adjacent(t).filter((x) => x !== p);
        if (adj.length) this.damage(p, adj[0], this.gambler(p, 2), { attack: true });
        if (Math.random() < 0.5 && t.alive) {
          t.stunned = true;
          this.log(`${t.name} 下回合点数效果失效`, "debuff");
        }
        p.hunterAmmo = Math.max(0, p.hunterAmmo - 1);
        this.toEnd();
        return;
      }

      if (pending.kind === "divine") {
        const dmg = 3 + 3 * p.blades + p.divineBonus;
        this.damage(p, t, dmg, { attack: true, ignoreDodge: true });
        p.divineCd = 5;
        this.log(`${p.name} 神之刃造成 ${dmg} 伤害`, "special");
        this.toAction();
        return;
      }

      if (pending.kind === "hunterGun") {
        this.damage(p, t, 2, { attack: true });
        p.hunterCd = 4;
        this.toAction();
        return;
      }

      this.toAction();
    }

    applyPoison(p, t) {
      const two = this.alive().length === 2;
      const bonus = p.identity === 1 && two ? 1 : 0;
      t.poison = { turns: 3, lethal: p.identity === 1, bonus };
      this.log(
        `${p.name} 对 ${t.name} 下毒（3 回合，每回合 1d3${bonus ? "+1" : ""}${p.identity === 1 ? "，可致命" : ""}）`,
        "debuff"
      );
      if (p.identity === 1 && two) this.damage(p, t, 2, { attack: false });
    }

    /* ---------------- 数值 ---------------- */
    gambler(p, v) {
      return p.identity === 3 && Math.random() < 2 / 3 ? v + 2 : v;
    }

    damage(src, tgt, amount, opts) {
      opts = opts || {};
      const attack = opts.attack !== false;
      const canKill = opts.canKill !== false;
      if (!tgt || !tgt.alive || amount <= 0) return 0;

      if (opts.debuff && tgt.immune > 0) {
        this.log(`${tgt.name} 免疫了减益`, "good");
        return 0;
      }

      if (attack && !opts.ignoreDodge && tgt.dodge > 0) {
        if (d6() % 2 === 0) {
          tgt.dodge--;
          this.log(`${tgt.name} 闪避了攻击（剩 ${tgt.dodge} 闪避）`, "good");
          return 0;
        }
      }

      if (tgt.immune > 0) amount = Math.min(amount, 2);
      amount = Math.max(0, amount - (tgt.dmgReduce || 0));
      if (this.state.round >= 7) amount += 1;        // 血月：所有伤害 +1
      if (!canKill) amount = Math.min(amount, Math.max(0, tgt.hp - 1));
      amount = Math.max(0, amount);
      if (amount <= 0) return 0;

      tgt.hp -= amount;
      if (src && src !== tgt) {
        src.damage += amount;
        if (src.lifesteal) this.heal(src, Math.floor(amount / 2));
      }
      this.log(
        `${src ? src.name : "毒"} → ${tgt.name}：${amount} 伤害（剩 ${Math.max(0, tgt.hp)}）`,
        "dmg"
      );
      if (tgt.hp <= 0) this.onLethal(tgt, src);
      return amount;
    }

    heal(p, amount, src) {
      if (!p || !p.alive || amount <= 0) return 0;
      if (p.healLock > 0) {
        this.log(`${p.name} 被禁疗，回复失败`, "bad");
        return 0;
      }
      if (this.state.round >= 7) amount = Math.max(0, amount - 1);  // 血月：治疗 -1
      if (src && src.identity === 3 && Math.random() < 0.5) amount += 2;
      const before = p.hp;
      p.hp = Math.min(p.maxHp, p.hp + amount);
      const gained = p.hp - before;
      if (gained > 0) {
        this.state.healTotal += gained;
        this.log(`${p.name} 回复 ${gained} HP（${p.hp}/${p.maxHp}）`, "heal");
      }
      return gained;
    }

    /* ---------------- 死亡 / 复活 / 拼点 ---------------- */
    onLethal(p, src) {
      if (p.hp > 0 || !p.alive) return;

      if (p.identity === 6 && !p.revived) {
        p.hp = dice(3);
        p.revived = true;
        p.poison = null;
        p.healLock = 0;
        this.log(`${p.name} 触发随机生成器复活（${p.hp} HP）`, "special");
        return;
      }

      if (!this.state.lastDance && p.charge >= 2 && !p.revived) {
        p.hp = Math.min(15, 5 + 2 * p.charge);
        p.charge = 0;
        p.revived = true;
        p.immune = 3;
        this.log(`${p.name} 积电复活（${p.hp} HP）`, "special");
        return;
      }

      if (!this.state.lastDance && p.duels > 0) {
        p.duels--;
        const prev = this.prevAlive(p);
        if (prev) {
          const a = d6();
          const b = d6();
          if (a > b) {
            const diff = a - b;
            p.hp = 5;
            p.immune = 3;
            this.log(`${p.name} 临死拼点 ${a}:${b} 成功，回到 5 HP，反伤 ${prev.name} ${diff}`, "special");
            this.damage(p, prev, diff, { canKill: false, attack: false });
            return;
          }
          this.log(`${p.name} 临死拼点 ${a}:${b} 失败`, "bad");
        }
      }

      p.alive = false;
      p.hp = 0;
      this.log(`${p.name} 倒下`, "death");
      this.checkEndgame();
    }

    checkEndgame() {
      if (this.state.winner) return;
      const alive = this.alive();

      if (alive.length === 1) {
        this.state.winner = alive[0];
        this.state.phase = "gameover";
        this.log(`${alive[0].name} 是最后的赢家！`, "special");
        return;
      }
      if (alive.length === 0) {
        this.state.phase = "gameover";
        this.log(`同归于尽，没有赢家`, "special");
        return;
      }

      if (alive.length === 2 && !this.state.lastDance && this.state.startedWith >= 3) {
        this.state.lastDance = true;
        this.state.lastDanceTurns = 0;
        for (const p of alive) {
          p.hp = 10;
          p.maxHp = 10;
          p.blades = 0;
          p.ammo = 0;
          p.hunterAmmo = 0;
          p.charge = 0;
          p.poison = null;
          p.healLock = 0;
          p.regen = 0;
          p.dodge = 1;
          p.duels = 0;
          p.revived = true;
          p.lifesteal = false;
          p.stunned = false;
          p.immune = 0;
          p.dmgReduce = 0;
          p.hunterCd = 0;
          p.divineCd = 0;
          p.healCd = 0;
        }
        this.log(
          `最后一舞！${alive[0].name} vs ${alive[1].name}，双方 10 HP、1 闪避，3 轮定胜负`,
          "special"
        );
      }
    }

    resolveLastDance() {
      const alive = this.alive();
      if (alive.length === 1) {
        this.state.winner = alive[0];
        this.state.phase = "gameover";
        return;
      }
      if (alive.length !== 2) return;
      const [x, y] = alive;
      let win = null;
      if (x.hp !== y.hp) win = x.hp > y.hp ? x : y;
      else if (x.kills !== y.kills) win = x.kills > y.kills ? x : y;
      else {
        const rx = d6(), ry = d6();
        win = rx >= ry ? x : y;
        this.log(`最后一舞平局，掷骰 ${rx}:${ry}`, "special");
      }
      this.state.winner = win;
      this.state.phase = "gameover";
      this.log(`${win.name} 赢得最后一舞！`, "special");
    }

    /* ---------------- 阶段切换 ---------------- */
    toAction() {
      this.state.pending = null;
      if (this.state.winner) return;
      this.checkEndgame();
      if (this.state.winner) return;
      this.state.phase = "action";
    }

    toEnd() {
      this.state.pending = null;
      this.checkEndgame();
      if (this.state.winner) return;
      this.state.phase = "end";
    }

    endTurn() {
      if (this.state.phase === "gameover" || this.state.phase === "target"
        || this.state.phase === "roll" || this.state.phase === "chargeChoice") return;
      if (this.state.lastDance) {
        this.state.lastDanceTurns++;
        if (this.state.lastDanceTurns >= 6) { this.resolveLastDance(); return; }
      }
      this.advance();
    }

    advance() {
      if (this.state.winner) return;
      const n = this.state.players.length;
      let idx = this.state.turnIdx;
      for (let k = 0; k < n; k++) {
        idx = (idx + 1) % n;
        if (idx === 0) this.state.round++;
        if (this.state.players[idx].alive) break;
      }
      this.state.turnIdx = idx;
      if (this.state.round >= 7 && !this.state.bloodMoonAnnounced) {
        this.state.bloodMoonAnnounced = true;
        this.log("血月升起：从本回合起，所有伤害 +1，所有治疗 -1", "special");
      }
      this.beginTurn();
    }

    /* ---------------- 自由行动 ---------------- */
    chooseCharge(choice) {
      if (this.state.phase !== "chargeChoice") return;
      const p = this.current();
      if (choice === "heal") {
        this.heal(p, 2, p);
        this.toAction();
        return;
      }
      const es = this.enemies(p);
      if (!es.length) { this.toAction(); return; }
      this.setTarget("chargeDamage", es);
    }

    beginBlade() {
      if (this.state.phase !== "action") return;
      const p = this.current();
      if (p.blades <= 0) return;
      const es = this.enemies(p);
      if (!es.length) return;
      this.setTarget("blade", es);
    }

    spendCharge() {
      if (this.state.phase !== "action") return;
      const p = this.current();
      if (p.charge < 2) return;
      const amount = 2 * p.charge;
      p.charge = 0;
      this.heal(p, amount, p);
    }

    useDivine() {
      if (this.state.phase !== "action") return;
      const p = this.current();
      if (p.identity !== 5 || p.divineCd > 0) return;
      const es = this.enemies(p);
      if (!es.length) return;
      this.setTarget("divine", es);
    }

    useHunterGun() {
      if (this.state.phase !== "action") return;
      const p = this.current();
      if (p.identity !== 2 || p.hunterCd > 0) return;
      const es = this.enemies(p);
      if (!es.length) return;
      this.setTarget("hunterGun", es);
    }

    useHealAction() {
      if (this.state.phase !== "action") return;
      const p = this.current();
      if (p.identity !== 6 || p.healCd > 0) return;
      this.heal(p, d6(), p);
      p.healCd = 3;
      this.toEnd();
    }

    bomb(p) {
      this.log(`${p.name} 引爆电量炸弹！`, "special");
      for (const e of this.enemies(p)) {
        this.damage(p, e, 8, { attack: false, canKill: true });
        e.healLock = Math.max(e.healLock, 3);
        e.charge = Math.max(0, e.charge - 2);
      }
      this.heal(p, 6, p);
      p.charge = 0;
    }
  }

  global.DiceGame = { Game, ID };
})(typeof window !== "undefined" ? window : globalThis);

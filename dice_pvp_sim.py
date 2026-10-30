#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
骰子PVP v1.3.1 —— 蒙特卡洛模拟器
=================================

用法示例
--------
    python dice_pvp_sim.py ffa --players 6 --games 20000
    python dice_pvp_sim.py ffa --players 6 --games 20000 --decouple
    python dice_pvp_sim.py setup --players 6 --games 100000
    python dice_pvp_sim.py matrix --games 1000
    python dice_pvp_sim.py duel --id1 1 --id2 5 --games 20000 --first 1
    python dice_pvp_sim.py mirror --id1 2 --games 3000
    python dice_pvp_sim.py gamble --id1 1 --id2 2 --games 3000
    python dice_pvp_sim.py boss --players 5 --games 5000

本模拟器把规则里没有写死的地方做成了“显式假设”，集中在下方 ASSUMPTIONS。
默认按 v1.3.1 原文实现；有争议的点用命令行开关测试。

ASSUMPTIONS（默认值）
---------------------
1. 身份 = 开局骰面，座次 = 骰面降序；同点者整组重投，直到所有人不同。
   --decouple 可改为“先排座次，再随机发身份”，用来对比解耦后的胜率。
2. “回合”按“该玩家自己的回合”计时；毒在受害者回合开始时跳。
3. 毒默认不叠加，重复施放只刷新；--poison-stack 可改为叠加。
4. 药师的面1：可指定目标、可致命；2人局额外+1/跳并立刻造成2伤害。
5. 赌徒的+2默认按“每次伤害/治疗实例”独立判定，概率取原文的50%
   （原文“3以上成功”实际是66.7%，用 --gambler-proc 0.667 可测试）。
6. 骰利刃默认只能在自己回合使用（“任意时间”在模拟里无法公平建模，
   这样会略微低估刃的强度）。
7. 临死拼点简化为“受到致命伤时触发”，而不是“预判下回合将死时触发”。
8. 机器人复活默认按附属的“每人最多一次”；--robot-unlimited-revive 测试被动。
9. 6人局在 linked 模式下身份固定为 P1=6 … P6=1；2人局没有终局模式（原文两个终局都要求开局≥3人）。
10. Boss模式为近似实现：Boss每个面转成全队AOE，具体转换见 boss_turn()。
11. 豪赌 P2 的拼点默认“无限制”（999）；--gamble-p2-duels 3 可测试与基础规则一致的版本。
"""

from __future__ import annotations

import argparse
import random
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Optional


ID_NAMES = {
    1: "药师",
    2: "猎人",
    3: "赌徒",
    4: "机器人",
    5: "剑圣",
    6: "随机生成器",
    0: "Boss",
}

# 粗略威胁权重，仅用于AI选目标
THREAT = {1: 1.25, 2: 1.00, 3: 0.95, 4: 1.05, 5: 1.30, 6: 1.00, 0: 1.0}


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
@dataclass
class Config:
    n: int = 6
    games: int = 5000
    seed: int = 20261029
    identity_mode: str = "linked"       # linked | decoupled
    duel_cap: int = 3
    robot_unlimited_revive: bool = False
    gambler_proc: float = 0.50
    poison_stack: bool = False
    hp_scaling: bool = False
    endgame: str = "auto"               # auto | gamble | lastdance | none
    ai_mode: str = "focus"              # focus | threat
    gamble_p2_duels: int = 999          # 豪赌玩家2的拼点次数；原文“无限制”
    boss_hp: int = 80
    max_rounds: int = 80


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------
@dataclass
class Poison:
    turns: int
    lethal: bool
    bonus: int
    source: Optional[Player] = None


@dataclass
class Player:
    pid: int
    name: str
    identity: int
    seat: int
    hp: int
    max_hp: int
    alive: bool = True

    poison: list[Poison] = field(default_factory=list)
    heal_lock: int = 0
    dmg_reduce: int = 0          # 受到的伤害 -N
    dmg_debuff: int = 0          # 造成的伤害 -N（电量炸弹）
    dodge: int = 0
    blades: int = 0
    ammo: int = 0                # 普通骰子霰弹枪弹药
    hunter_ammo: int = 0         # 猎人的3伤霰弹枪
    hunter_cd: int = 0
    charge: int = 0
    duels_left: int = 3
    duels_used: int = 0
    revived: bool = False
    regen: int = 0
    lifesteal: bool = False
    stunned: bool = False
    immune_turns: int = 0
    divine_cd: int = 0
    divine_bonus: int = 0
    heal_cd: int = 0
    is_boss: bool = False
    is_gamble_p1: bool = False
    is_gamble_p2: bool = False

    damage_dealt: float = 0.0
    kills: int = 0


# ---------------------------------------------------------------------------
# 生成玩家
# ---------------------------------------------------------------------------
def make_player(pid: int, seat: int, ident: int, cfg: Config, rng: random.Random,
                n: Optional[int] = None) -> Player:
    n = n if n is not None else cfg.n
    base = 20 + (3 * (n - 2) if cfg.hp_scaling else 0)
    if ident == 6:
        hp = sum(rng.randint(1, 6) for _ in range(6))
        if cfg.hp_scaling:
            hp += 3 * (n - 2)
        max_hp = 99          # “HP没有上限”
    else:
        hp = base
        max_hp = base

    p = Player(pid=pid, name=f"P{seat}", identity=ident, seat=seat,
               hp=hp, max_hp=max_hp)
    if ident == 4:
        p.duels_left = 0     # 机器人无法拼点
    elif ident == 6:
        p.duels_left = 2
    else:
        p.duels_left = cfg.duel_cap
    return p


def make_boss(cfg: Config) -> Player:
    b = Player(pid=0, name="Boss", identity=0, seat=99,
               hp=cfg.boss_hp, max_hp=cfg.boss_hp)
    b.is_boss = True
    b.duels_left = 0
    return b


def roll_distinct(n: int, rng: random.Random) -> list[int]:
    """每人一颗骰子；同点者整组重投，直到所有人点数不同。"""
    rolls = [rng.randint(1, 6) for _ in range(n)]
    for _ in range(5000):
        c = Counter(rolls)
        dup = {v for v, k in c.items() if k > 1}
        if not dup:
            return rolls
        for i in range(n):
            if rolls[i] in dup:
                rolls[i] = rng.randint(1, 6)
    # 极端情况兜底
    return rng.sample(range(1, 7), n)


def setup_players(cfg: Config, rng: random.Random) -> list[Player]:
    n = cfg.n
    rolls = roll_distinct(n, rng)
    order = sorted(range(n), key=lambda i: -rolls[i])

    if cfg.identity_mode == "linked":
        idents = [rolls[idx] for idx in order]
    else:
        idents = rng.sample(range(1, 7), n)

    players = []
    for seat, ident in enumerate(idents, 1):
        players.append(make_player(seat, seat, ident, cfg, rng, n=n))
    return players


def setup_boss(cfg: Config, rng: random.Random) -> tuple[list[Player], Player]:
    n = cfg.n
    rolls = roll_distinct(n, rng)
    order = sorted(range(n), key=lambda i: -rolls[i])
    boss_idx = order[0]

    players = []
    seat = 1
    for idx in order:
        if idx == boss_idx:
            continue
        players.append(make_player(seat, seat, rolls[idx], cfg, rng, n=n))
        seat += 1
    return players, make_boss(cfg)


# ---------------------------------------------------------------------------
# 游戏
# ---------------------------------------------------------------------------
class Game:
    def __init__(self, players: list[Player], cfg: Config, rng: random.Random,
                 started_with: int):
        self.players = players
        self.order = sorted(players, key=lambda p: p.seat)
        self.cfg = cfg
        self.rng = rng
        self.started_with = started_with
        self.round = 0
        self.endgame: Optional[str] = None
        self.winner = None
        self.boss = next((p for p in players if p.is_boss), None)
        self.boss_mode = self.boss is not None
        self.turns = 0
        self.face_counts = Counter()
        self.damage_by_face = Counter()
        self.heal_total = 0

    # --- 查询 -------------------------------------------------------------
    def alive_players(self) -> list[Player]:
        return [p for p in self.order if p.alive]

    def alive_count(self) -> int:
        return sum(1 for p in self.order if p.alive)

    def alive_enemies(self, p: Player) -> list[Player]:
        if self.boss_mode:
            if p.is_boss:
                return [q for q in self.order if q.alive and not q.is_boss]
            return [self.boss] if self.boss and self.boss.alive else []
        return [q for q in self.order if q.alive and q is not p]

    def next_alive(self, p: Player) -> Optional[Player]:
        if p not in self.order:
            return None
        idx = self.order.index(p)
        for k in range(1, len(self.order)):
            q = self.order[(idx + k) % len(self.order)]
            if q.alive and q is not p:
                return q
        return None

    def prev_alive(self, p: Player) -> Optional[Player]:
        if p not in self.order:
            return None
        idx = self.order.index(p)
        for k in range(1, len(self.order)):
            q = self.order[(idx - k) % len(self.order)]
            if q.alive and q is not p:
                return q
        return None

    def other(self, p: Player) -> Optional[Player]:
        es = self.alive_enemies(p)
        return es[0] if es else None

    # --- 核心数值 ---------------------------------------------------------
    def gambler(self, p: Player, base: int) -> int:
        if p.identity == 3 and self.rng.random() < self.cfg.gambler_proc:
            return base + 2
        return base

    def deal_damage(self, src: Optional[Player], tgt: Player, amount: int, *,
                    can_kill: bool = True, is_debuff: bool = False,
                    is_attack: bool = True, ignore_dodge: bool = False) -> int:
        if not tgt.alive or amount <= 0:
            return 0

        # 豪赌玩家2：无法被减益致死
        if is_debuff and tgt.is_gamble_p2:
            can_kill = False

        # 闪避（只对攻击）
        if is_attack and not ignore_dodge and tgt.dodge > 0:
            if self.rng.randint(1, 6) % 2 == 0:
                tgt.dodge -= 1
                return 0

        # 复活后的3回合：免疫减益、单次最多2伤
        if tgt.immune_turns > 0:
            if is_debuff:
                return 0
            amount = min(amount, 2)

        amount = max(0, amount - tgt.dmg_reduce)
        if src is not None and is_attack and src.dmg_debuff > 0:
            amount = max(0, amount - 1)

        if not can_kill:
            amount = min(amount, max(0, tgt.hp - 1))

        if amount <= 0:
            return 0

        tgt.hp -= amount
        if src is not None and src is not tgt:
            src.damage_dealt += amount

        # 随机生成器的吸血buff
        if src is not None and src.lifesteal and amount > 0:
            self.heal(src, amount // 2, src=None)

        if tgt.hp <= 0:
            self.on_lethal(tgt, src, is_debuff)
        return amount

    def heal(self, p: Player, amount: int, src: Optional[Player] = None) -> int:
        if not p.alive or amount <= 0:
            return 0
        if p.heal_lock > 0:
            return 0
        if src is not None and src.identity == 3:
            amount = self.gambler(src, amount)
        before = p.hp
        p.hp = min(p.max_hp, p.hp + amount)
        gained = p.hp - before
        self.heal_total += gained
        return gained

    def set_hp(self, src: Player, tgt: Player, value: int) -> None:
        if not tgt.alive:
            return
        value = min(value, tgt.max_hp)
        before = tgt.hp
        tgt.hp = value
        if value < before and src is not tgt:
            src.damage_dealt += before - value
        if tgt.hp <= 0:
            self.on_lethal(tgt, src, False)

    def add_poison(self, tgt: Player, turns: int, lethal: bool, bonus: int,
                   source: Optional[Player] = None) -> None:
        if not tgt.alive:
            return
        if self.cfg.poison_stack:
            tgt.poison.append(Poison(turns, lethal, bonus, source))
        else:
            had_lethal = any(x.lethal for x in tgt.poison)
            tgt.poison = [Poison(turns, lethal or had_lethal, bonus, source)]

    # --- 死亡 / 拼点 / 复活 ----------------------------------------------
    def on_lethal(self, tgt: Player, src: Optional[Player], is_debuff: bool) -> None:
        if tgt.hp > 0 or not tgt.alive:
            return
        if tgt.is_boss:
            self.kill(tgt, src)
            return
        if self.can_duel(tgt):
            if self.attempt_duel(tgt):
                return
        if self.try_revive(tgt):
            return
        self.kill(tgt, src)

    def can_duel(self, tgt: Player) -> bool:
        if self.boss_mode or self.endgame == "lastdance":
            return False
        if tgt.is_gamble_p1 or tgt.identity == 4:
            return False
        if tgt.duels_left <= 0:
            return False
        if self.alive_count() < 2:
            return False
        return self.prev_alive(tgt) is not None

    def attempt_duel(self, tgt: Player) -> bool:
        prev = self.prev_alive(tgt)
        if prev is None:
            return False
        a = self.rng.randint(1, 6)
        b = self.rng.randint(1, 6)
        tgt.duels_left -= 1
        tgt.duels_used += 1
        if a > b:
            self.deal_damage(tgt, prev, a - b, can_kill=False, is_attack=False)
            tgt.hp = max(tgt.hp, 5)
            tgt.immune_turns = 3
            return True
        return False

    def try_revive(self, tgt: Player) -> bool:
        # 随机生成器第一次死亡：3d6 复活，不是积电复活
        if tgt.identity == 6 and not tgt.revived:
            tgt.hp = sum(self.rng.randint(1, 6) for _ in range(3))
            tgt.revived = True
            tgt.poison.clear()
            tgt.heal_lock = 0
            return True

        # 豪赌 / 最后一舞：积电复活失效
        if self.endgame in ("gamble", "lastdance"):
            return False

        if tgt.charge >= 2:
            if tgt.revived and not (tgt.identity == 4 and self.cfg.robot_unlimited_revive):
                return False
            hp = min(15, 5 + 2 * tgt.charge)
            tgt.hp = hp
            tgt.charge = 0
            tgt.revived = True
            tgt.immune_turns = 3
            return True
        return False

    def kill(self, tgt: Player, src: Optional[Player]) -> None:
        tgt.alive = False
        tgt.hp = 0
        if src is not None and not src.is_boss:
            src.kills += 1
        if self.boss_mode:
            return
        self.check_endgame()

    # --- 终局 -------------------------------------------------------------
    def check_endgame(self) -> None:
        if self.boss_mode or self.endgame:
            return
        alive = self.alive_players()
        if len(alive) != 2 or self.started_with < 3:
            return
        if self.cfg.endgame == "none":
            return
        a, b = alive
        hi, lo = (a, b) if a.hp >= b.hp else (b, a)
        if self.cfg.endgame in ("auto", "gamble") and hi.hp >= 15 and lo.hp <= 5:
            self.start_gamble(hi, lo)
        elif self.cfg.endgame in ("auto", "lastdance"):
            self.start_lastdance(a, b)

    def start_gamble(self, p1: Player, p2: Player) -> None:
        for p in (p1, p2):
            p.poison.clear()
            p.heal_lock = 0
            p.dmg_reduce = 0
            p.dmg_debuff = 0
            p.regen = 0
            p.stunned = False
        p1.max_hp = 30
        p1.hp = 30
        p1.dodge = 0
        p1.duels_left = 0
        p1.is_gamble_p1 = True
        p2.max_hp = 12
        p2.hp = 10
        p2.dodge = 2
        p2.dmg_reduce = 1
        p2.duels_left = self.cfg.gamble_p2_duels
        p2.is_gamble_p2 = True
        self.endgame = "gamble"

    def start_lastdance(self, a: Player, b: Player) -> None:
        for p in (a, b):
            p.hp = 10
            p.max_hp = 10
            p.blades = 0
            p.ammo = 0
            p.hunter_ammo = 0
            p.charge = 0
            p.poison.clear()
            p.heal_lock = 0
            p.dmg_reduce = 0
            p.dmg_debuff = 0
            p.regen = 0
            p.dodge = 2
            p.duels_left = 0
            p.lifesteal = False
            p.stunned = False
            p.is_gamble_p1 = False
            p.is_gamble_p2 = False
        self.endgame = "lastdance"

    # --- 回合流程 ---------------------------------------------------------
    def start_turn(self, p: Player) -> None:
        p.immune_turns = max(0, p.immune_turns - 1)
        p.heal_lock = max(0, p.heal_lock - 1)
        if not p.is_gamble_p2:          # 豪赌玩家2的“受伤-1”是常驻
            p.dmg_reduce = max(0, p.dmg_reduce - 1)
        p.dmg_debuff = max(0, p.dmg_debuff - 1)
        p.hunter_cd = max(0, p.hunter_cd - 1)
        p.divine_cd = max(0, p.divine_cd - 1)
        p.heal_cd = max(0, p.heal_cd - 1)

        if p.regen > 0:
            self.heal(p, 2, src=p)
            p.regen -= 1

        for ps in list(p.poison):
            if not p.alive:
                break
            dmg = self.rng.randint(1, 6) + ps.bonus
            actual = self.deal_damage(ps.source, p, dmg, can_kill=ps.lethal,
                                      is_debuff=True, is_attack=False)
            self.damage_by_face[1] += actual
            ps.turns -= 1
            if ps.turns <= 0 and ps in p.poison:
                p.poison.remove(ps)

    def take_turn(self, p: Player) -> None:
        if not p.alive:
            return
        if p.is_boss:
            self.boss_turn()
            return

        self.start_turn(p)
        if not p.alive:
            return

        if p.stunned:
            p.stunned = False
            return

        # 猎人：每3回合一次的2伤无溅射霰弹枪
        if p.identity == 2 and p.hunter_cd == 0:
            enemies = self.alive_enemies(p)
            if enemies:
                low = min(e.hp for e in enemies)
                if low <= 2 or p.hp <= 8:
                    t = self.pick_target(p, enemies)
                    before = p.damage_dealt
                    self.deal_damage(p, t, 2, is_attack=True)
                    self.damage_by_face[2] += p.damage_dealt - before
                    p.hunter_cd = 3
        if not p.alive:
            return

        # 随机生成器：花一回合回1~6，2回合CD
        if (p.identity == 6 and p.heal_cd == 0 and p.hp <= 10
                and self.rng.random() < 0.5):
            self.heal(p, self.rng.randint(1, 6), src=p)
            p.heal_cd = 2
            return

        # 剑圣：每5回合一次神之刃
        if p.identity == 5 and p.divine_cd == 0:
            self.use_divine(p)
            if self.alive_count() <= 1:
                return

        # 积电换血
        if p.charge >= 2 and p.hp <= 6:
            self.heal(p, 2 * p.charge, src=p)
            p.charge = 0

        roll = self.rng.randint(1, 6)
        face = roll
        if p.identity == 4 and roll == 3:
            face = 4       # 机器人把弱面改成电量炸弹

        self.face_counts[face] += 1
        before_dmg = p.damage_dealt
        ends_turn = self.resolve_face(p, face)
        self.damage_by_face[face] += p.damage_dealt - before_dmg
        if ends_turn:
            return
        self.use_blades(p)

    def resolve_face(self, p: Player, face: int) -> bool:
        if face == 1:
            self.face_poison(p)
        elif face == 2:
            return self.face_shotgun(p)
        elif face == 3:
            self.face_gold(p)
        elif face == 4:
            self.face_charge(p)
        elif face == 5:
            return self.face_blade(p)
        elif face == 6:
            self.face_random(p)
        return False

    # --- 六个面 -----------------------------------------------------------
    def face_poison(self, p: Player) -> None:
        if self.boss_mode and not p.is_boss:
            self.add_poison(self.boss, 3, True, 0, p)
            return
        enemies = self.alive_enemies(p)
        if not enemies:
            return

        if p.identity == 1:              # 药师：指定目标 + 可致命
            target = max(enemies, key=lambda e: (e.hp, THREAT[e.identity]))
            lethal = True
            bonus = 1 if self.alive_count() == 2 else 0
            self.add_poison(target, 3, lethal, bonus, p)
            if self.alive_count() == 2:
                self.deal_damage(p, target, 2, can_kill=True, is_attack=False)
        else:
            r = self.rng.randint(1, 6)
            target = self.prev_alive(p) if r % 2 == 0 else self.next_alive(p)
            if target is None or target is p:
                target = self.next_alive(p)
            if target is not None:
                self.add_poison(target, 3, False, 0, p)

    def face_shotgun(self, p: Player) -> bool:
        p.ammo = min(2, p.ammo + 1)
        if p.identity == 5:
            p.divine_bonus += 2         # 剑圣获得霰弹枪，神之刃+2
        enemies = self.alive_enemies(p)
        if not enemies:
            return False
        target = self.pick_target(p, enemies)
        if target is None:
            return False
        # 射击现在就能造成伤害+控制，通常优于存弹
        self.do_shotgun(p, target, fixed=None,
                        always_splash=(p.identity == 2))
        return True

    def do_shotgun(self, p: Player, tgt: Player, fixed: Optional[int],
                   always_splash: bool, hunter: bool = False) -> None:
        if hunter:
            p.hunter_ammo -= 1
            base = 3
        else:
            p.ammo -= 1
            base = fixed if fixed is not None else self.rng.randint(1, 6)
        base = self.gambler(p, base)
        self.deal_damage(p, tgt, base, is_attack=True)

        if base >= 3 or always_splash:
            if not (self.boss_mode and tgt.is_boss):
                for adj in self.adjacent(tgt, p):
                    self.deal_damage(p, adj, self.gambler(p, 3), is_attack=True)

        tgt.stunned = True

    def adjacent(self, tgt: Player, exclude: Player) -> list[Player]:
        alive = [q for q in self.order if q.alive]
        if tgt not in alive:
            return []
        idx = alive.index(tgt)
        out = []
        for k in (-1, 1):
            q = alive[(idx + k) % len(alive)]
            if q is not tgt and q is not exclude and q not in out:
                out.append(q)
        return out

    def face_gold(self, p: Player) -> None:
        r = self.rng.randint(1, 6)
        if r % 2 == 0:
            self.heal(p, 4, src=p)
        else:
            if self.boss_mode and not p.is_boss:
                target = self.boss
            else:
                target = self.next_alive(p)
            if target is not None:
                self.deal_damage(p, target, self.gambler(p, 3), is_attack=True)

    def face_charge(self, p: Player) -> None:
        if self.endgame == "gamble":
            if p.is_gamble_p1:
                t = self.other(p)
                if t is not None:
                    self.deal_damage(p, t, 1, is_attack=False)
            elif p.is_gamble_p2:
                p.dodge = min(3, p.dodge + 1)
            return

        p.charge += 1
        if p.identity == 4:
            self.heal(p, 2, src=p)
        if p.charge >= 5:
            self.trigger_bomb(p)

    def trigger_bomb(self, p: Player) -> None:
        for e in self.alive_enemies(p):
            can_kill = e.hp < 5
            self.deal_damage(p, e, 10, can_kill=can_kill, is_attack=False)
            e.heal_lock = max(e.heal_lock, 5)
            e.dmg_debuff = max(e.dmg_debuff, 5)
            e.charge = max(0, e.charge - 3)
        self.heal(p, 8, src=p)
        p.charge = 0

    def face_blade(self, p: Player) -> bool:
        if p.identity == 2:             # 猎人：刃变3伤溅射霰弹枪
            p.hunter_ammo = min(2, p.hunter_ammo + 1)
            enemies = self.alive_enemies(p)
            if not enemies:
                return False
            target = self.pick_target(p, enemies)
            if target is not None:
                self.do_shotgun(p, target, fixed=3, always_splash=True,
                                hunter=True)
                return True
            return False

        p.blades = min(5, p.blades + 1)
        return False

    def face_random(self, p: Player) -> None:
        if p.hp <= 5:
            p.lifesteal = True
            return

        if self.boss_mode and not p.is_boss:
            target = self.boss
        else:
            enemies = self.alive_enemies(p)
            if not enemies:
                return
            high = [e for e in enemies if e.hp > 14]
            if p.hp <= 8:
                target = p
            elif high:
                target = max(high, key=lambda e: e.hp)
            elif p.hp < 14:
                target = p
            else:
                target = max(enemies, key=lambda e: e.hp)

        value = sum(self.rng.randint(1, 6) for _ in range(4))
        self.set_hp(p, target, value)

    def use_blades(self, p: Player) -> None:
        before = p.damage_dealt
        while p.blades > 0 and p.alive:
            enemies = self.alive_enemies(p)
            if not enemies:
                break
            target = self.pick_target(p, enemies)
            if target is None:
                break

            # 剑圣会留刃堆神之刃；其他人有刃就用，压血线/抢节奏
            if p.identity == 5 and p.divine_cd > 1 and p.blades < 3:
                break
            use = False
            if target.hp <= 4 * p.blades:
                use = True
            elif p.blades >= 2:
                use = True
            elif p.hp <= 12:
                use = True
            elif len(enemies) <= 2 and target.hp <= 8:
                use = True
            if not use:
                break

            p.blades -= 1
            if target.blades > 0:
                self.deal_damage(p, p, 2, can_kill=False, is_attack=False)
            self.deal_damage(p, target, 4, is_attack=True)
        self.damage_by_face[5] += p.damage_dealt - before

    def use_divine(self, p: Player) -> None:
        enemies = self.alive_enemies(p)
        if not enemies:
            return
        target = self.pick_target(p, enemies)
        dmg = 3 + 3 * p.blades + p.divine_bonus
        self.deal_damage(p, target, dmg, is_attack=True, ignore_dodge=True)
        p.divine_cd = 5

    # --- AI ---------------------------------------------------------------
    def pick_target(self, p: Player, enemies: list[Player]) -> Optional[Player]:
        if self.boss_mode and not p.is_boss:
            return self.boss
        if not enemies:
            return None
        if self.cfg.ai_mode == "focus":
            # 优先能补掉的，其次压最低血量，最后看威胁
            killable = [e for e in enemies if e.hp <= 4]
            if killable:
                return min(killable, key=lambda e: e.hp)
            return min(enemies, key=lambda e: (e.hp, -THREAT.get(e.identity, 1.0)))
        killable = [e for e in enemies if e.hp <= 4]
        if killable:
            return min(killable, key=lambda e: e.hp)
        return max(enemies, key=lambda e: (e.hp * THREAT.get(e.identity, 1.0), e.hp))

    # --- Boss -------------------------------------------------------------
    def boss_turn(self) -> None:
        b = self.boss
        if b is None or not b.alive:
            return
        self.start_turn(b)
        if not b.alive:
            return
        players = [q for q in self.order if q.alive and not q.is_boss]
        if not players:
            return

        roll = self.rng.randint(1, 6)
        if roll == 1:                       # 毒全队
            for q in players:
                self.add_poison(q, 3, False, 0, b)
        elif roll == 2:                     # 霰弹全队
            d = self.rng.randint(1, 6)
            for q in players:
                self.deal_damage(b, q, d, is_attack=True)
        elif roll == 3:
            if self.rng.randint(1, 6) % 2 == 0:
                self.heal(b, 4, src=b)
            else:
                for q in players:
                    self.deal_damage(b, q, 3, is_attack=True)
        elif roll == 4:
            b.charge += 1
            if b.charge >= 5:
                for q in players:
                    self.deal_damage(b, q, 10, can_kill=True, is_attack=False)
                self.heal(b, 8, src=b)
                b.charge = 0
        elif roll == 5:                     # 刃全队
            for q in players:
                self.deal_damage(b, q, 4, is_attack=True)
        elif roll == 6:                     # 改HP
            q = self.rng.choice(players)
            self.set_hp(b, q, sum(self.rng.randint(1, 6) for _ in range(4)))

    # --- 主循环 -----------------------------------------------------------
    def run(self) -> None:
        if self.boss_mode:
            self.run_boss()
            return

        self.check_endgame()
        guard = 0
        limit = self.cfg.max_rounds * max(1, len(self.order))
        while self.alive_count() > 1 and guard < limit:
            for p in list(self.order):
                if not p.alive:
                    continue
                if self.alive_count() <= 1:
                    break
                self.take_turn(p)
                self.turns += 1
                guard += 1
                if guard >= limit:
                    break
                if self.alive_count() <= 1:
                    break
            self.round += 1
        self.finish()

    def run_boss(self) -> None:
        guard = 0
        limit = self.cfg.max_rounds * max(1, len(self.order))
        while guard < limit and self.boss and self.boss.alive:
            if not any(p.alive and not p.is_boss for p in self.order):
                break
            for p in list(self.order):
                if not p.alive:
                    continue
                self.take_turn(p)
                self.turns += 1
                guard += 1
                if not self.boss.alive:
                    break
                if not any(q.alive and not q.is_boss for q in self.order):
                    break
            self.round += 1
        self.finish()

    def finish(self) -> None:
        if self.boss_mode:
            if self.boss is not None and not self.boss.alive:
                self.winner = "players"
            elif not any(p.alive and not p.is_boss for p in self.order):
                self.winner = "boss"
            else:
                self.winner = None
            return
        alive = self.alive_players()
        self.winner = alive[0] if len(alive) == 1 else None


# ---------------------------------------------------------------------------
# 统计与输出
# ---------------------------------------------------------------------------
def pct(x: float) -> str:
    return f"{100.0 * x:6.1f}%"


def simulate_ffa(cfg: Config) -> dict:
    seat_wins = Counter()
    ident_wins = Counter()
    ident_appear = Counter()
    seat_ident = defaultdict(Counter)
    endgames = Counter()
    rounds = []
    timeouts = 0
    dmg_sum = defaultdict(float)
    dmg_n = Counter()
    win_hp = []
    face_counts = Counter()
    damage_by_face = Counter()
    heal_total = 0

    for g in range(cfg.games):
        rng = random.Random(cfg.seed + g * 104729)
        players = setup_players(cfg, rng)
        game = Game(players, cfg, rng, started_with=cfg.n)
        game.run()

        rounds.append(game.round)
        endgames[game.endgame or "none"] += 1
        face_counts.update(game.face_counts)
        damage_by_face.update(game.damage_by_face)
        heal_total += game.heal_total
        for p in players:
            ident_appear[p.identity] += 1
            seat_ident[p.seat][p.identity] += 1
            dmg_sum[p.identity] += p.damage_dealt
            dmg_n[p.identity] += 1

        if game.winner is None:
            timeouts += 1
        else:
            seat_wins[game.winner.seat] += 1
            ident_wins[game.winner.identity] += 1
            win_hp.append(game.winner.hp)

    return {
        "seat_wins": seat_wins,
        "ident_wins": ident_wins,
        "ident_appear": ident_appear,
        "seat_ident": seat_ident,
        "endgames": endgames,
        "rounds": rounds,
        "timeouts": timeouts,
        "dmg_sum": dmg_sum,
        "dmg_n": dmg_n,
        "win_hp": win_hp,
        "face_counts": face_counts,
        "damage_by_face": damage_by_face,
        "heal_total": heal_total,
    }


def print_ffa(res: dict, cfg: Config, quiet: bool = False) -> None:
    games = cfg.games
    print(f"\n=== FFA {cfg.n}p | games={games} | identity={cfg.identity_mode} "
          f"| hp_scaling={cfg.hp_scaling} ===")
    print(f"avg rounds: {statistics.mean(res['rounds']):.2f}   "
          f"median: {statistics.median(res['rounds']):.1f}   "
          f"timeouts: {res['timeouts']} ({res['timeouts']/games:.2%})")
    if res["win_hp"]:
        print(f"avg winner HP left: {statistics.mean(res['win_hp']):.1f}")

    eg = res["endgames"]
    total = sum(eg.values())
    print("endgame: " + "  ".join(f"{k}={v/total:.1%}" for k, v in eg.items()))

    if quiet:
        print("identity win%: " + "  ".join(
            f"{ID_NAMES[i]}={res['ident_wins'][i]/max(1,res['ident_appear'][i]):.1%}"
            for i in range(1, 7) if res["ident_appear"][i]))
        return

    print("\nseat win rates:")
    print("seat  win%    dominant identity")
    for seat in range(1, cfg.n + 1):
        wr = res["seat_wins"][seat] / games
        dist = res["seat_ident"][seat]
        top_id, top_n = dist.most_common(1)[0]
        share = top_n / max(1, sum(dist.values()))
        label = ID_NAMES[top_id]
        if share < 0.999:
            label += f" (mixed, {share:.0%})"
        print(f"{seat:>4}  {pct(wr)}  {label}")

    print("\nidentity win rates (only games where identity appeared):")
    print("id  identity        win%    avg dmg")
    for ident in range(1, 7):
        app = res["ident_appear"][ident]
        if app == 0:
            print(f"{ident:>2}  {ID_NAMES[ident]:<12}  n/a")
            continue
        wr = res["ident_wins"][ident] / app
        avg_dmg = res["dmg_sum"][ident] / max(1, res["dmg_n"][ident])
        print(f"{ident:>2}  {ID_NAMES[ident]:<12}  {pct(wr)}  {avg_dmg:5.2f}")

    total_turns = sum(res["face_counts"].values())
    print(f"\nface rolls/game: {total_turns / games:.1f}   "
          f"avg alive/turn: "
          f"{total_turns / max(1, games * statistics.mean(res['rounds'])):.2f}   "
          f"damage/face-roll: "
          f"{sum(res['damage_by_face'].values()) / max(1, total_turns):.2f}   "
          f"heal/game: {res['heal_total'] / games:.1f}")
    print("face  rolls/game  dmg/game  dmg/roll")
    for face in range(1, 7):
        r = res["face_counts"][face] / games
        d = res["damage_by_face"][face] / games
        print(f"{face:>4}  {r:>10.2f}  {d:>8.2f}  "
              f"{d / r if r else 0:>8.2f}")


def simulate_setup(cfg: Config) -> dict:
    ties = 0
    ident_counter = Counter()
    for g in range(cfg.games):
        rng = random.Random(cfg.seed + g * 7919)
        raw = [rng.randint(1, 6) for _ in range(cfg.n)]
        if len(set(raw)) < cfg.n:
            ties += 1
        players = setup_players(cfg, rng)
        for p in players:
            ident_counter[p.identity] += 1
    return {"ties": ties, "idents": ident_counter}


def print_setup(res: dict, cfg: Config) -> None:
    print(f"\n=== SETUP {cfg.n}p | games={cfg.games} ===")
    print(f"raw tie rate (needs reroll): {res['ties']/cfg.games:.2%}")
    print("identity frequency:")
    for i in range(1, 7):
        print(f"  {i} {ID_NAMES[i]:<12} {res['idents'][i]/max(1,cfg.games):.2%}")


def simulate_matrix(cfg: Config) -> dict:
    ids = list(range(1, 7))
    table = {i: {} for i in ids}
    for i in ids:
        for j in ids:
            if i == j:
                continue
            wins = 0
            total = 0
            for first in (1, 2):
                for g in range(cfg.games):
                    rng = random.Random(cfg.seed + i * 100000 + j * 1000
                                        + first * 100 + g)
                    a = make_player(1, 1, i if first == 1 else j, cfg, rng, n=2)
                    b = make_player(2, 2, j if first == 1 else i, cfg, rng, n=2)
                    game = Game([a, b], cfg, rng, started_with=2)
                    game.run()
                    if game.winner is not None and game.winner.identity == i:
                        wins += 1
                    total += 1
            table[i][j] = wins / total
    return table


def print_matrix(table: dict) -> None:
    ids = list(range(1, 7))
    print("\n=== 2p identity matrix (row win% vs column, both seat orders) ===")
    print("row\\col " + " ".join(f"{ID_NAMES[j]:>6}" for j in ids))
    for i in ids:
        cells = []
        for j in ids:
            if i == j:
                cells.append("  --  ")
            else:
                cells.append(f"{100*table[i][j]:5.1f}%")
        print(f"{ID_NAMES[i]:<8}" + " ".join(cells))


def simulate_duel(cfg: Config, id1: int, id2: int, first: int) -> tuple[float, float]:
    wins = 0
    rounds = []
    for g in range(cfg.games):
        rng = random.Random(cfg.seed + g * 15485863)
        a = make_player(1, 1, id1 if first == 1 else id2, cfg, rng, n=2)
        b = make_player(2, 2, id2 if first == 1 else id1, cfg, rng, n=2)
        game = Game([a, b], cfg, rng, started_with=2)
        game.run()
        rounds.append(game.round)
        if game.winner is not None and game.winner.identity == id1:
            wins += 1
    return wins / cfg.games, statistics.mean(rounds)


def simulate_mirror(cfg: Config, ident: int) -> tuple[float, float]:
    """双方同身份，测先手优势：seat1 的胜率。"""
    wins1 = 0
    rounds = []
    for g in range(cfg.games):
        rng = random.Random(cfg.seed + g * 217645177)
        a = make_player(1, 1, ident, cfg, rng, n=2)
        b = make_player(2, 2, ident, cfg, rng, n=2)
        game = Game([a, b], cfg, rng, started_with=2)
        game.run()
        rounds.append(game.round)
        if game.winner is not None and game.winner.seat == 1:
            wins1 += 1
    return wins1 / cfg.games, statistics.mean(rounds)


def simulate_gamble(cfg: Config, id1: int, id2: int) -> dict:
    """直接构造“豪赌”局面：P1=15HP（打完后30），P2=5HP（打完后10+闪避2）。"""
    p1_wins = 0
    p2_wins = 0
    timeouts = 0
    rounds = []
    for g in range(cfg.games):
        rng = random.Random(cfg.seed + g * 290000011)
        a = make_player(1, 1, id1, cfg, rng, n=2)
        b = make_player(2, 2, id2, cfg, rng, n=2)
        a.hp = 15
        b.hp = 5
        game = Game([a, b], cfg, rng, started_with=3)
        game.start_gamble(a, b)
        game.run()
        rounds.append(game.round)
        if game.winner is a:
            p1_wins += 1
        elif game.winner is b:
            p2_wins += 1
        else:
            timeouts += 1
    return {
        "p1_wins": p1_wins,
        "p2_wins": p2_wins,
        "timeouts": timeouts,
        "rounds": rounds,
    }


def simulate_boss(cfg: Config) -> dict:
    player_wins = 0
    boss_wins = 0
    timeouts = 0
    rounds = []
    boss_hp_left = []
    for g in range(cfg.games):
        rng = random.Random(cfg.seed + g * 32452843)
        players, boss = setup_boss(cfg, rng)
        game = Game(players + [boss], cfg, rng, started_with=cfg.n)
        game.run()
        rounds.append(game.round)
        boss_hp_left.append(max(0, boss.hp))
        if game.winner == "players":
            player_wins += 1
        elif game.winner == "boss":
            boss_wins += 1
        else:
            timeouts += 1
    return {
        "player_wins": player_wins,
        "boss_wins": boss_wins,
        "timeouts": timeouts,
        "rounds": rounds,
        "boss_hp_left": boss_hp_left,
    }


def print_boss(res: dict, cfg: Config) -> None:
    games = cfg.games
    print(f"\n=== BOSS {cfg.n}p (boss_hp={cfg.boss_hp}) | games={games} ===")
    print(f"players win: {res['player_wins']/games:.1%}   "
          f"boss win: {res['boss_wins']/games:.1%}   "
          f"timeout: {res['timeouts']/games:.1%}")
    print(f"avg rounds: {statistics.mean(res['rounds']):.2f}   "
          f"avg boss HP left: {statistics.mean(res['boss_hp_left']):.1f}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="骰子PVP v1.3.1 蒙特卡洛模拟器")
    ap.add_argument("mode", choices=["ffa", "setup", "matrix", "duel", "mirror",
                                    "gamble", "boss"])
    ap.add_argument("--players", type=int, default=6)
    ap.add_argument("--games", type=int, default=None,
                    help="默认 ffa/boss=3000, matrix=300, 其他=3000")
    ap.add_argument("--seed", type=int, default=20261029)
    ap.add_argument("--decouple", action="store_true",
                    help="座次与身份解耦：先排座次，再随机发身份")
    ap.add_argument("--duel-cap", type=int, default=3)
    ap.add_argument("--robot-unlimited-revive", action="store_true")
    ap.add_argument("--gambler-proc", type=float, default=0.50)
    ap.add_argument("--poison-stack", action="store_true")
    ap.add_argument("--hp-scaling", action="store_true")
    ap.add_argument("--endgame", choices=["auto", "gamble", "lastdance", "none"],
                    default="auto")
    ap.add_argument("--ai", choices=["focus", "threat"], default="focus")
    ap.add_argument("--gamble-p2-duels", type=int, default=999)
    ap.add_argument("--boss-hp", type=int, default=80)
    ap.add_argument("--max-rounds", type=int, default=80)
    ap.add_argument("--id1", type=int, default=1)
    ap.add_argument("--id2", type=int, default=2)
    ap.add_argument("--first", type=int, choices=[1, 2], default=1)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    cfg = Config(
        n=args.players,
        games=(args.games if args.games is not None
               else (300 if args.mode == "matrix" else 3000)),
        seed=args.seed,
        identity_mode="decoupled" if args.decouple else "linked",
        duel_cap=args.duel_cap,
        robot_unlimited_revive=args.robot_unlimited_revive,
        gambler_proc=args.gambler_proc,
        poison_stack=args.poison_stack,
        hp_scaling=args.hp_scaling,
        endgame=args.endgame,
        ai_mode=args.ai,
        gamble_p2_duels=args.gamble_p2_duels,
        boss_hp=args.boss_hp,
        max_rounds=args.max_rounds,
    )

    if args.mode == "ffa":
        res = simulate_ffa(cfg)
        print_ffa(res, cfg, quiet=args.quiet)
    elif args.mode == "setup":
        res = simulate_setup(cfg)
        print_setup(res, cfg)
    elif args.mode == "matrix":
        table = simulate_matrix(cfg)
        print_matrix(table)
    elif args.mode == "duel":
        wr, avg_rounds = simulate_duel(cfg, args.id1, args.id2, args.first)
        print(f"\n{ID_NAMES[args.id1]} (seat {args.first}) vs "
              f"{ID_NAMES[args.id2]}: win rate = {wr:.2%} "
              f"(games={cfg.games}, avg rounds={avg_rounds:.1f})")
    elif args.mode == "mirror":
        wr, avg_rounds = simulate_mirror(cfg, args.id1)
        print(f"\nmirror {ID_NAMES[args.id1]}: seat1 win rate = {wr:.2%} "
              f"(games={cfg.games}, avg rounds={avg_rounds:.1f})")
    elif args.mode == "gamble":
        res = simulate_gamble(cfg, args.id1, args.id2)
        games = cfg.games
        print(f"\n=== GAMBLE 15/5: P1={ID_NAMES[args.id1]} vs "
              f"P2={ID_NAMES[args.id2]} | games={games} ===")
        print(f"P1 (30HP, 无拼点) win: {res['p1_wins']/games:.1%}   "
              f"P2 (10HP+闪避2+减伤1+无限拼点) win: "
              f"{res['p2_wins']/games:.1%}   "
              f"timeout: {res['timeouts']/games:.1%}")
        print(f"avg rounds: {statistics.mean(res['rounds']):.1f}")
    elif args.mode == "boss":
        res = simulate_boss(cfg)
        print_boss(res, cfg)


if __name__ == "__main__":
    main()

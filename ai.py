"""Simple heuristic AI: summons its best monster, attacks when favorable."""

import time

import engine
from cards import CardDef, Player
from engine import Duel

DELAY = 0.9


def _pause() -> None:
    time.sleep(DELAY)


def take_turn(duel: Duel, me: Player) -> None:
    _special_phase(duel, me)
    if duel.winner:
        return
    _main_phase(duel, me)
    if duel.winner:
        return
    _battle_phase(duel, me)
    if duel.winner:
        return
    _cleanup_phase(duel, me)


# ---------------------------------------------------------------- phases

def _special_phase(duel: Duel, me: Player) -> None:
    """Play useful spells and set traps before summoning."""
    for i in range(len(me.hand) - 1, -1, -1):
        if duel.winner:
            return
        c = me.hand[i]
        if c.kind == "spell" and _spell_useful(duel, me, c):
            t_idx = _strongest_field_idx(duel, me) if c.effect.get("type") == "buff" else None
            engine.play_spell(duel, me, i, t_idx)
            _pause()
        elif c.kind == "trap" and len(me.traps) < 2:
            engine.set_trap(duel, me, i)
            _pause()


def _spell_useful(duel: Duel, me: Player, c: CardDef) -> bool:
    opp = duel.other(me)
    kind = c.effect.get("type") if c.effect else None
    if kind == "heal":
        return me.lp <= 2500
    if kind == "burn":
        return True
    if kind == "draw":
        return len(me.hand) < engine.HAND_LIMIT
    if kind == "buff":
        return bool(me.field)
    if kind == "destroy":
        return bool(opp.field)
    return False


def _strongest_field_idx(duel: Duel, me: Player) -> int:
    return max(range(len(me.field)),
               key=lambda i: engine.effective_atk(duel, me, me.field[i]))


def _main_phase(duel: Duel, me: Player) -> None:
    if me.normal_summoned or not me.hand or len(me.field) >= engine.MAX_FIELD:
        return
    opp = duel.other(me)
    best_enemy_atk = max(
        (engine.effective_atk(duel, opp, m) for m in opp.field if m.position == "attack"),
        default=0,
    )

    best_idx, best_score = None, -1
    for i, card in enumerate(me.hand):
        if card.kind != "monster":
            continue
        ok, _ = engine.can_summon(duel, me, card)
        if not ok:
            continue
        score = _summon_score(duel, me, card)
        if score > best_score:
            best_idx, best_score = i, score

    if best_idx is None:
        return

    card = me.hand[best_idx]
    tributes = _pick_tributes(duel, me, card)
    if tributes is None:
        return  # not worth tributing

    position = "attack" if (not opp.field or card.atk > best_enemy_atk) else "defense"
    engine.summon(duel, me, best_idx, position, tributes)
    _pause()


def _summon_score(duel: Duel, me: Player, card: CardDef) -> float:
    score = card.atk + card.defense * 0.3
    eff = card.effect
    if eff:
        if eff.get("type") == "burn":
            score += eff.get("value", 0) * 0.6
        elif eff.get("type") in ("draw", "heal"):
            score += eff.get("value", 1) * 200
        elif eff.get("type") in ("piercing", "aura_atk"):
            score += 150
    # Don't tribute for a monster weaker than what we'd give up.
    if card.tributes_needed:
        tribute_cost = _tribute_cost(duel, me, card.tributes_needed)
        if card.atk < tribute_cost * 0.85:
            return -1
        score -= tribute_cost * 0.5
    return score


def _tribute_cost(duel: Duel, me: Player, needed: int) -> int:
    weakest = sorted(me.field, key=lambda m: engine.effective_atk(duel, me, m))[:needed]
    return sum(engine.effective_atk(duel, me, m) for m in weakest)


def _pick_tributes(duel: Duel, me: Player, card: CardDef) -> list[int] | None:
    needed = card.tributes_needed
    if needed == 0:
        return []
    if needed > len(me.field):
        return None
    weakest = sorted(range(len(me.field)),
                     key=lambda i: engine.effective_atk(duel, me, me.field[i]))[:needed]
    cost = sum(engine.effective_atk(duel, me, me.field[i]) for i in weakest)
    if card.atk < cost * 0.85:
        return None
    return weakest


def _battle_phase(duel: Duel, me: Player) -> None:
    opp = duel.other(me)
    while True:
        if duel.winner:
            return
        acted = False
        for i, m in enumerate(me.field):
            if m.position != "attack" or m.attacks_left <= 0:
                continue
            target = _pick_target(duel, me, m)
            if target == "skip":
                continue
            engine.attack(duel, me, i, target)
            _pause()
            acted = True
            break  # field may have changed — rescan
        if not acted:
            return


def _pick_target(duel: Duel, me: Player, m) -> int | None | str:
    opp = duel.other(me)
    my_atk = engine.effective_atk(duel, me, m)
    if not opp.field:
        return None  # direct attack

    best_idx, best_score = None, 0
    for j, t in enumerate(opp.field):
        if t.position == "attack":
            t_atk = engine.effective_atk(duel, opp, t)
            if my_atk > t_atk:
                score = (my_atk - t_atk) + t_atk * 0.5 + 100
            elif my_atk == t_atk and t_atk > my_atk * 0.5:
                score = t_atk * 0.3  # favorable trade only if theirs is big
                score = score if t.card.atk >= my_atk else 0
            else:
                score = 0  # suicide — skip
        else:
            if my_atk > t.card.defense:
                pierce = my_atk - t.card.defense if engine.has_piercing(m) else 0
                score = 150 + pierce + t.card.defense * 0.15
            else:
                score = 0
        if score > best_score:
            best_idx, best_score = j, score
    return best_idx if best_idx is not None else "skip"


def _cleanup_phase(duel: Duel, me: Player) -> None:
    """Main phase 2: shift vulnerable attackers to defense."""
    opp = duel.other(me)
    best_enemy_atk = max(
        (engine.effective_atk(duel, opp, m) for m in opp.field if m.position == "attack"),
        default=0,
    )
    for i, m in enumerate(me.field):
        if m.position == "attack" and not m.summoned_this_turn and not m.attacked_this_turn:
            if engine.effective_atk(duel, me, m) < best_enemy_atk and m.card.defense >= 1200:
                engine.switch_position(duel, me, i)
                _pause()

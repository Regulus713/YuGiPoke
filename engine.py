"""Core duel engine: turns, summoning, combat, effects."""

from cards import CardDef, Monster, Player

STARTING_LP = 4000
STARTING_HAND = 4
MAX_FIELD = 5
HAND_LIMIT = 6
MAX_TRAPS = 3


def log(msg: str) -> None:
    print(msg)


class Duel:
    def __init__(self, p1: Player, p2: Player):
        self.players = [p1, p2]
        self.turn_index = 0
        self.turn_number = 1
        self.winner: Player | None = None
        self.loser_reason = ""

    @property
    def current(self) -> Player:
        return self.players[self.turn_index % 2]

    @property
    def opponent(self) -> Player:
        return self.players[(self.turn_index + 1) % 2]

    def other(self, player: Player) -> Player:
        return self.players[1] if self.players[0] is player else self.players[0]


# ---------------------------------------------------------------- helpers

def has_piercing(monster: Monster) -> bool:
    eff = monster.card.effect
    return bool(eff and eff.get("trigger") == "passive" and eff.get("type") == "piercing")


def aura_bonus(duel: Duel, owner: Player) -> int:
    """Total ATK bonus from friendly aura monsters — applied to *other* monsters only."""
    total = 0
    sources = 0
    for m in owner.field:
        eff = m.card.effect
        if eff and eff.get("trigger") == "passive" and eff.get("type") == "aura_atk":
            total += eff.get("value", 0)
            sources += 1
    return total, sources


def _equip_buff(monster: Monster) -> int:
    return sum(c.effect.get("value", 0) for c in monster.equipped if c.effect)


def effective_atk(duel: Duel, owner: Player, monster: Monster) -> int:
    bonus, sources = aura_bonus(duel, owner)
    buff = _equip_buff(monster)
    if sources and not _is_aura(monster):
        return monster.card.atk + bonus + buff
    # an aura monster benefits from other aura monsters but not itself
    if sources > 1 and _is_aura(monster):
        return monster.card.atk + bonus - monster.card.effect.get("value", 0) + buff
    return monster.card.atk + buff


def _is_aura(monster: Monster) -> bool:
    eff = monster.card.effect
    return bool(eff and eff.get("trigger") == "passive" and eff.get("type") == "aura_atk")


def check_game_over(duel: Duel) -> None:
    for p in duel.players:
        if p.lp <= 0:
            p.lp = 0
            duel.winner = duel.other(p)
            duel.loser_reason = f"{p.name}'s LP reached 0."


def draw_cards(duel: Duel, player: Player, n: int = 1) -> None:
    for _ in range(n):
        if not player.deck:
            duel.winner = duel.other(player)
            duel.loser_reason = f"{player.name} could not draw — decked out."
            return
        player.hand.append(player.deck.pop())


def destroy(duel: Duel, owner: Player, monster: Monster) -> None:
    owner.field.remove(monster)
    owner.graveyard.append(monster.card)
    owner.graveyard.extend(monster.equipped)
    log(f"  {monster.card.name} is destroyed!")
    trigger_effect(duel, owner, monster, "on_destroy")


def trigger_effect(duel: Duel, owner: Player, monster: Monster, when: str) -> None:
    eff = monster.card.effect
    if not eff or eff.get("trigger") != when:
        return
    opp = duel.other(owner)
    kind, value = eff.get("type"), eff.get("value", 0)
    if kind == "burn":
        opp.lp -= value
        log(f"  Effect: {monster.card.name} deals {value} damage to {opp.name}!")
    elif kind == "heal":
        owner.lp += value
        log(f"  Effect: {owner.name} gains {value} LP!")
    elif kind == "draw":
        log(f"  Effect: {owner.name} draws {value} card(s)!")
        draw_cards(duel, owner, value)
    check_game_over(duel)


# ---------------------------------------------------------------- turn flow

def start_turn(duel: Duel) -> None:
    p = duel.current
    p.normal_summoned = False
    for m in p.field:
        m.summoned_this_turn = False
        m.attacked_this_turn = False
        m.position_changed = False
        m.attacks_left = 1
    # The player going first skips their very first draw.
    if not (duel.turn_number == 1 and duel.turn_index == 0):
        draw_cards(duel, p, 1)


def discard(player: Player, hand_idx: int) -> CardDef:
    card = player.hand.pop(hand_idx)
    player.graveyard.append(card)
    log(f"  {player.name} discards {card.name} (hand limit {HAND_LIMIT}).")
    return card


def end_turn(duel: Duel) -> None:
    duel.turn_index += 1
    if duel.turn_index % 2 == 0:
        duel.turn_number += 1


# ---------------------------------------------------------------- spells & traps

def play_spell(duel: Duel, player: Player, hand_idx: int,
               target_idx: int | None = None) -> tuple[bool, str]:
    card = player.hand[hand_idx]
    if card.kind != "spell":
        return False, "Not a spell card."
    opp = duel.other(player)
    e = card.effect
    if e.get("type") == "buff":
        if target_idx is None or target_idx >= len(player.field):
            return False, "Choose one of your monsters."
    elif e.get("type") == "destroy" and not opp.field:
        return False, "Opponent has no monsters."

    player.hand.pop(hand_idx)
    log(f"  {player.name} plays {card.name}!")

    kind, value = e.get("type"), e.get("value", 0)
    if kind == "buff":
        # equip: the card stays attached to the monster until it leaves the field
        m = player.field[target_idx]
        m.equipped.append(card)
        log(f"  {card.name} equipped to {m.card.name} (+{value} ATK).")
    else:
        player.graveyard.append(card)
        if kind == "heal":
            player.lp += value
            log(f"  {player.name} gains {value} LP.")
        elif kind == "burn":
            opp.lp -= value
            log(f"  {opp.name} takes {value} damage!")
        elif kind == "draw":
            draw_cards(duel, player, value)
        elif kind == "destroy":
            wi = min(range(len(opp.field)),
                     key=lambda i: effective_atk(duel, opp, opp.field[i]))
            destroy(duel, opp, opp.field[wi])
    check_game_over(duel)
    return True, ""


def set_trap(duel: Duel, player: Player, hand_idx: int) -> tuple[bool, str]:
    card = player.hand[hand_idx]
    if card.kind != "trap":
        return False, "Not a trap card."
    if len(player.traps) >= MAX_TRAPS:
        return False, "Trap zone is full (3)."
    player.hand.pop(hand_idx)
    player.traps.append(card)
    log(f"  {player.name} sets a trap face-down.")
    return True, ""


def _resolve_trap(duel: Duel, player: Player, m: Monster) -> bool:
    """The defender's first set trap fires on the attack declaration."""
    opp = duel.other(player)
    if not opp.traps:
        return False
    trap = opp.traps.pop(0)
    opp.graveyard.append(trap)
    log(f"  {opp.name}'s trap {trap.name} activates!")
    te = trap.effect.get("type")
    if te == "negate":
        log(f"  {m.card.name}'s attack is negated!")
    elif te == "destroy_atk":
        destroy(duel, player, m)
    elif te == "counter":
        dmg = round(effective_atk(duel, player, m) / 100) * 50
        player.lp -= dmg
        log(f"  {player.name} takes {dmg} damage!")
        check_game_over(duel)
    return True  # attack is consumed either way


# ---------------------------------------------------------------- actions

def can_summon(duel: Duel, player: Player, card: CardDef) -> tuple[bool, str]:
    if player.normal_summoned:
        return False, "You have already used your normal summon this turn."
    if len(player.field) >= MAX_FIELD:
        return False, "Your field is full."
    if card.tributes_needed > len(player.field):
        return False, f"{card.name} requires {card.tributes_needed} tribute(s)."
    return True, ""


def summon(duel: Duel, player: Player, hand_idx: int,
           position: str, tribute_indices: list[int] | None = None) -> bool:
    card = player.hand[hand_idx]
    ok, _ = can_summon(duel, player, card)
    if not ok:
        return False
    needed = card.tributes_needed
    tribute_indices = tribute_indices or []
    if len(tribute_indices) != needed:
        return False

    player.hand.pop(hand_idx)
    for i in sorted(tribute_indices, reverse=True):
        tributed = player.field.pop(i)
        player.graveyard.append(tributed.card)
        player.graveyard.extend(tributed.equipped)
        log(f"  {player.name} tributes {tributed.card.name}.")

    monster = Monster(card=card, position=position)
    player.field.append(monster)
    player.normal_summoned = True
    pos_word = "attack position" if position == "attack" else "defense position"
    log(f"  {player.name} summons {card.name} in {pos_word}!")
    trigger_effect(duel, player, monster, "on_summon")
    return True


def switch_position(duel: Duel, player: Player, field_idx: int) -> tuple[bool, str]:
    m = player.field[field_idx]
    if m.summoned_this_turn:
        return False, f"{m.card.name} was summoned this turn and can't change position."
    if m.attacked_this_turn:
        return False, f"{m.card.name} already attacked this turn."
    if m.position_changed:
        return False, f"{m.card.name} already changed position this turn."
    m.position = "defense" if m.position == "attack" else "attack"
    m.position_changed = True
    m.attacks_left = 0 if m.position == "defense" else m.attacks_left
    log(f"  {player.name} switches {m.card.name} to {m.position} position.")
    return True, ""


def attack(duel: Duel, player: Player, field_idx: int,
           target_idx: int | None = None) -> tuple[bool, str]:
    m = player.field[field_idx]
    opp = duel.other(player)
    if m.position != "attack":
        return False, f"{m.card.name} is in defense position."
    if m.attacks_left <= 0:
        return False, f"{m.card.name} has already attacked."
    if target_idx is None and opp.field:
        return False, "Opponent has monsters — you must attack one of them."

    a = effective_atk(duel, player, m)
    m.attacks_left = 0
    m.attacked_this_turn = True

    # a set trap fires on the attack declaration
    if opp.traps and _resolve_trap(duel, player, m):
        return True, ""

    if target_idx is None:
        opp.lp -= a
        log(f"  {m.card.name} attacks {opp.name} directly for {a} damage!")
        check_game_over(duel)
        return True, ""

    t = opp.field[target_idx]
    if t.position == "attack":
        d = effective_atk(duel, opp, t)
        log(f"  {m.card.name} ({a} ATK) attacks {t.card.name} ({d} ATK)!")
        if a > d:
            destroy(duel, opp, t)
            opp.lp -= a - d
            log(f"  {opp.name} takes {a - d} damage.")
        elif a < d:
            destroy(duel, player, m)
            player.lp -= d - a
            log(f"  {player.name} takes {d - a} damage.")
        else:
            destroy(duel, opp, t)
            destroy(duel, player, m)
            log("  Both monsters are destroyed!")
    else:
        d = t.card.defense
        log(f"  {m.card.name} ({a} ATK) attacks {t.card.name} ({d} DEF)!")
        if a > d:
            destroy(duel, opp, t)
            if has_piercing(m):
                opp.lp -= a - d
                log(f"  Piercing! {opp.name} takes {a - d} damage.")
        elif a < d:
            player.lp -= d - a
            log(f"  Attack fails — {player.name} takes {d - a} damage.")
        else:
            log("  Neither monster is destroyed.")
    check_game_over(duel)
    return True, ""


def weakest_hand_index(player: Player) -> int:
    """Index of the least useful card in hand (for auto-discard)."""
    def score(i: int) -> int:
        c = player.hand[i]
        return c.atk + c.defense if c.kind == "monster" else 500
    return min(range(len(player.hand)), key=score)

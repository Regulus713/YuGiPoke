"""Terminal duel — a small Yu-Gi-Oh-style 1v1 card game.

Run:  python main.py
"""

import os
import random
import sys

import ai
import engine
from cards import Player, build_deck, load_card_db, load_deck_lists


class C:  # ANSI colors
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"


def clear() -> None:
    os.system("cls" if os.name == "nt" else "clear")


def prompt(msg: str) -> str:
    try:
        return input(msg).strip()
    except EOFError:
        return "concede"


# ---------------------------------------------------------------- rendering

def monster_line(i: int, m, duel, owner) -> str:
    atk = engine.effective_atk(duel, owner, m)
    bonus = f"{C.GREEN}(+{atk - m.card.atk}){C.RESET}" if atk != m.card.atk else ""
    eq = f" {C.GREEN}⚔{','.join(c.name for c in m.equipped)}{C.RESET}" if m.equipped else ""
    pos = f"{C.YELLOW}ATK{C.RESET}" if m.position == "attack" else f"{C.BLUE}DEF{C.RESET}"
    return f"  [{i + 1}] {m.card.name} — ATK {atk}{bonus} / DEF {m.card.defense}  [{pos}]{eq}"


def render_board(duel: engine.Duel, me: Player) -> None:
    opp = duel.other(me)
    print(f"\n{C.BOLD}--- Turn {duel.turn_number} | {me.name} to act ---{C.RESET}")
    print(f"{C.RED}{opp.name}{C.RESET}: LP {C.RED}{opp.lp}{C.RESET} | "
          f"hand {len(opp.hand)} | deck {len(opp.deck)} | graveyard {len(opp.graveyard)}")
    if opp.field:
        for i, m in enumerate(opp.field):
            print(monster_line(i, m, duel, opp))
    else:
        print("  (no monsters)")
    if opp.traps:
        print(f"  {C.MAGENTA}[{len(opp.traps)} face-down trap(s)]{C.RESET}")
    print(f"{C.CYAN}{me.name}{C.RESET}: LP {C.GREEN}{me.lp}{C.RESET} | deck {len(me.deck)}")
    if me.field:
        for i, m in enumerate(me.field):
            print(monster_line(i, m, duel, me))
    else:
        print("  (no monsters)")
    if me.traps:
        print(f"  {C.MAGENTA}traps:{C.RESET} " + ", ".join(t.name for t in me.traps))


def render_hand(me: Player) -> None:
    print(f"{C.BOLD}Your hand:{C.RESET}")
    if not me.hand:
        print("  (empty)")
    for i, c in enumerate(me.hand):
        text = f" | {c.text}" if c.text else ""
        if c.kind == "monster":
            trib = f" | needs {c.tributes_needed} tribute(s)" if c.tributes_needed else ""
            typ = f" | {c.type}" if c.type else ""
            print(f"  [{i + 1}] {c.name} — ATK {c.atk}/DEF {c.defense} | Lv{c.level}{typ}{trib}{text}")
        else:
            tag = f"{C.GREEN}SPELL{C.RESET}" if c.kind == "spell" else f"{C.MAGENTA}TRAP{C.RESET}"
            print(f"  [{i + 1}] [{tag}] {c.name}{text}")


def print_help(phase: str) -> None:
    print(f"""{C.BOLD}Commands:{C.RESET}
  hand                  show your hand
  field                 show the board
  summon <#> [atk|def]  normal summon a monster (once per turn)
  switch <#>            change a monster's battle position
  spell <#>             play a spell card
  set <#>               set a trap face-down""")
    if phase == "battle":
        print("""  attack <#>            attack with a monster
  main                  go to main phase 2""")
    else:
        print("  battle                go to the battle phase")
    print("""  end                   end your turn
  concede               forfeit the duel""")


# ---------------------------------------------------------------- input handling

def parse_index(args: list[str], count: int) -> int | None:
    if not args:
        return None
    try:
        i = int(args[0]) - 1
    except ValueError:
        return None
    return i if 0 <= i < count else None


def choose_tributes(duel: engine.Duel, me: Player, needed: int) -> list[int] | None:
    print(f"Choose {needed} tribute(s) from your field:")
    for i, m in enumerate(me.field):
        print(monster_line(i, m, duel, me))
    raw = prompt(f"{C.BOLD}tributes>{C.RESET} ")
    try:
        idxs = [int(x) - 1 for x in raw.split()]
    except ValueError:
        return None
    if len(idxs) != needed or len(set(idxs)) != needed:
        return None
    if any(i < 0 or i >= len(me.field) for i in idxs):
        return None
    return idxs


def do_summon(duel: engine.Duel, me: Player, args: list[str]) -> None:
    i = parse_index(args, len(me.hand))
    if i is None:
        print("  Usage: summon <hand#> [atk|def]")
        return
    card = me.hand[i]
    if card.kind != "monster":
        print(f"  {card.name} is a {card.kind} card — use '{'spell' if card.kind == 'spell' else 'set'}'.")
        return
    ok, reason = engine.can_summon(duel, me, card)
    if not ok:
        print(f"  {reason}")
        return
    pos = args[1].lower() if len(args) > 1 else ""
    if pos not in ("atk", "def", "attack", "defense"):
        pos = prompt("  Position — [a]ttack or [d]efense? ").lower()
    position = "defense" if pos.startswith("d") else "attack"
    tributes = []
    if card.tributes_needed:
        tributes = choose_tributes(duel, me, card.tributes_needed)
        if tributes is None:
            print("  Summon cancelled.")
            return
    if not engine.summon(duel, me, i, position, tributes):
        print("  Summon failed.")


def do_switch(duel: engine.Duel, me: Player, args: list[str]) -> None:
    i = parse_index(args, len(me.field))
    if i is None:
        print("  Usage: switch <field#>")
        return
    ok, reason = engine.switch_position(duel, me, i)
    if not ok:
        print(f"  {reason}")


def do_spell(duel: engine.Duel, me: Player, args: list[str]) -> None:
    i = parse_index(args, len(me.hand))
    if i is None:
        print("  Usage: spell <hand#>")
        return
    card = me.hand[i]
    if card.kind != "spell":
        print(f"  {card.name} is not a spell card.")
        return
    target = None
    if card.effect and card.effect.get("type") == "buff":
        print("  Choose one of your monsters:")
        for j, m in enumerate(me.field):
            print(monster_line(j, m, duel, me))
        target = parse_index(prompt(f"{C.BOLD}target>{C.RESET} ").split(), len(me.field))
        if target is None:
            print("  Cancelled.")
            return
    ok, reason = engine.play_spell(duel, me, i, target)
    if not ok:
        print(f"  {reason}")


def do_trap(duel: engine.Duel, me: Player, args: list[str]) -> None:
    i = parse_index(args, len(me.hand))
    if i is None:
        print("  Usage: set <hand#>")
        return
    card = me.hand[i]
    if card.kind != "trap":
        print(f"  {card.name} is not a trap card.")
        return
    ok, reason = engine.set_trap(duel, me, i)
    if not ok:
        print(f"  {reason}")


def do_attack(duel: engine.Duel, me: Player, args: list[str]) -> None:
    i = parse_index(args, len(me.field))
    if i is None:
        print("  Usage: attack <field#>")
        return
    opp = duel.other(me)
    target = None
    if opp.field:
        print("  Choose a target:")
        for j, t in enumerate(opp.field):
            print(monster_line(j, t, duel, opp))
        ti = parse_index(prompt(f"{C.BOLD}target>{C.RESET} ").split(), len(opp.field))
        if ti is None:
            print("  Attack cancelled.")
            return
        target = ti
    ok, reason = engine.attack(duel, me, i, target)
    if not ok:
        print(f"  {reason}")


def handle_discards(me: Player) -> None:
    while len(me.hand) > engine.HAND_LIMIT:
        render_hand(me)
        i = parse_index(
            prompt(f"  Hand over {engine.HAND_LIMIT} — discard <#>: ").split(),
            len(me.hand))
        if i is None:
            i = engine.weakest_hand_index(me)
        engine.discard(me, i)


# ---------------------------------------------------------------- turn loop

def human_turn(duel: engine.Duel, me: Player, phase: str = "main") -> None:
    render_board(duel, me)
    render_hand(me)
    while not duel.winner:
        tag = {"main": "main", "battle": "battle", "main2": "main2"}[phase]
        raw = prompt(f"\n{C.BOLD}{tag}>{C.RESET} ")
        if not raw:
            continue
        parts = raw.lower().split()
        cmd, args = parts[0], parts[1:]

        if cmd in ("end", "e"):
            return
        if cmd in ("concede", "quit", "forfeit"):
            duel.winner = duel.other(me)
            duel.loser_reason = f"{me.name} conceded."
            return
        if cmd in ("help", "?", "commands"):
            print_help(phase)
        elif cmd in ("hand", "h"):
            render_hand(me)
        elif cmd in ("field", "f", "board"):
            render_board(duel, me)
        elif cmd in ("summon", "s") and phase != "battle":
            do_summon(duel, me, args)
            render_board(duel, me)
        elif cmd in ("switch", "sw", "pos") and phase != "battle":
            do_switch(duel, me, args)
            render_board(duel, me)
        elif cmd in ("spell", "sp", "play") and phase != "battle":
            do_spell(duel, me, args)
            render_board(duel, me)
        elif cmd in ("set", "trap") and phase != "battle":
            do_trap(duel, me, args)
            render_board(duel, me)
        elif cmd in ("battle", "b") and phase == "main":
            phase = "battle"
            print(f"{C.MAGENTA}--- Battle phase ---{C.RESET}")
        elif cmd in ("attack", "a") and phase == "battle":
            do_attack(duel, me, args)
            if not duel.winner:
                render_board(duel, me)
        elif cmd in ("main", "m") and phase == "battle":
            phase = "main2"
            print(f"{C.MAGENTA}--- Main phase 2 ---{C.RESET}")
        else:
            print("  Unknown or unavailable command. Type 'help'.")


# ---------------------------------------------------------------- setup & main

def pick_deck(decks: dict[str, list[str]], who: str) -> str:
    names = list(decks)
    print(f"{who}, choose a deck:")
    for i, n in enumerate(names):
        print(f"  [{i + 1}] {n} ({len(decks[n])} cards)")
    while True:
        raw = prompt("> ")
        try:
            i = int(raw) - 1
            if 0 <= i < len(names):
                return names[i]
        except ValueError:
            if raw.lower() in names:
                return raw.lower()
        print("  Invalid choice.")


def main() -> None:
    os.system("")  # enable ANSI on Windows terminals
    clear()
    print(f"""{C.BOLD}{C.RED}=====================================
   TERMINAL DUEL
   a tiny Yu-Gi-Oh-style card game
====================================={C.RESET}
Rules: 4000 LP. Summon monsters, attack to reduce LP to 0.
Lv5-6 monsters need 1 tribute, Lv7+ need 2. Hand limit {engine.HAND_LIMIT}.""")

    db = load_card_db()
    decks = load_deck_lists()

    n1 = prompt("Your name [You]: ") or "You"
    d1 = pick_deck(decks, n1)
    d2 = random.choice(list(decks))
    players = [Player(n1, deck=build_deck(decks[d1], db)),
               Player("CPU", deck=build_deck(decks[d2], db), is_ai=True)]
    print(f"CPU takes the {d2} deck.")

    random.shuffle(players)  # coin flip for who goes first
    duel = engine.Duel(*players)
    for p in players:
        engine.draw_cards(duel, p, engine.STARTING_HAND)

    print(f"\n{players[0].name} goes first! (first player skips their first draw)")
    prompt("Press Enter to start...")

    while not duel.winner:
        me = duel.current
        if not me.is_ai:
            clear()
        print(f"\n{C.BOLD}===== Turn {duel.turn_number} — {me.name}'s turn ====={C.RESET}")
        engine.start_turn(duel)
        if duel.winner:
            break
        if me.is_ai:
            ai.take_turn(duel, me)
        else:
            human_turn(duel, me)
        if duel.winner:
            break
        if me.is_ai:
            while len(me.hand) > engine.HAND_LIMIT:
                engine.discard(me, engine.weakest_hand_index(me))
        else:
            handle_discards(me)
        engine.end_turn(duel)

    loser = duel.other(duel.winner)
    print(f"\n{C.BOLD}{C.YELLOW}===== {duel.winner.name} WINS! ====={C.RESET}")
    print(duel.loser_reason)
    print(f"Final LP — {duel.winner.name}: {duel.winner.lp} | {loser.name}: {loser.lp}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nDuel aborted.")
        sys.exit(0)

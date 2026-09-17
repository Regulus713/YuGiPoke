"""Headless AI-vs-AI balance simulator.

Run: python simulate.py [--games N] [--seed S] [--cap T]

Pits the decks in cards.json against each other (random deck + random
first player each game) and reports win rates, matchup stats, game
length, and card-usage frequencies. Pure engine — no UI, no delays.
"""

import argparse
import os
import random
import re
import statistics
from collections import Counter

import ai
import engine
from cards import Player, build_deck, load_card_db, load_deck_lists


def out(msg: str = "") -> None:
    os.write(1, (msg + "\n").encode("utf-8", "replace"))

ai.DELAY = 0  # no sleeps between AI actions
engine.log = lambda msg: LOG.append(msg)  # capture instead of printing

LOG: list[str] = []


def run_game(db, decks, cap: int) -> dict:
    """Play one AI-vs-AI game; return result stats."""
    global LOG
    LOG = []

    names = list(decks)
    deck_of = {"A": random.choice(names), "B": random.choice(names)}
    players = [Player(n, deck=build_deck(decks[deck_of[n]], db), is_ai=True)
               for n in ("A", "B")]
    random.shuffle(players)  # coin flip for first player

    duel = engine.Duel(*players)
    for p in players:
        engine.draw_cards(duel, p, engine.STARTING_HAND)

    while not duel.winner and duel.turn_number <= cap:
        me = duel.current
        engine.start_turn(duel)
        if duel.winner:
            break
        ai.take_turn(duel, me)
        if duel.winner:
            break
        while len(me.hand) > engine.HAND_LIMIT:
            engine.discard(me, engine.weakest_hand_index(me))
        engine.end_turn(duel)

    return {
        "decks": tuple(deck_of.values()),
        "winner_deck": deck_of[duel.winner.name] if duel.winner else None,
        "went_first_won": bool(duel.winner) and duel.winner is players[0],
        "turns": duel.turn_number,
        "final_lp": duel.winner.lp if duel.winner else 0,
        "log": list(LOG),
    }


USAGE_PATTERNS = {
    "summon":   re.compile(r"summons (.+?) in"),
    "spell":    re.compile(r"plays (.+?)!"),
    "equip":    re.compile(r"(.+?) equipped to"),
    "trap_set": re.compile(r"sets a trap face-down"),
    "trap_act": re.compile(r"trap (.+?) activates"),
    "tribute":  re.compile(r"tributes (.+?)\."),
}


def card_usage(log: list[str]) -> Counter:
    c = Counter()
    for line in log:
        for key, pat in USAGE_PATTERNS.items():
            m = pat.search(line)
            if m:
                c[(key, m.group(1) if m.groups() else "(any)")] += 1
    return c


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--cap", type=int, default=200)
    args = ap.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    db = load_card_db()
    decks = load_deck_lists()

    wins, played = Counter(), Counter()
    draws = first_wins = 0
    turns, final_lps = [], []
    usage = Counter()

    for _ in range(args.games):
        r = run_game(db, decks, args.cap)
        turns.append(r["turns"])
        usage.update(card_usage(r["log"]))
        for d in set(r["decks"]):
            played[d] += 1
        if r["winner_deck"] is None:
            draws += 1
            continue
        wins[r["winner_deck"]] += 1
        final_lps.append(r["final_lp"])
        if r["went_first_won"]:
            first_wins += 1

    decided = args.games - draws
    out(f"\n===== SIM RESULTS — {args.games} games =====")
    out(f"{'deck':<8} {'win rate':>9}  (wins / games played)")
    for d in decks:
        out(f"  {d:<6} {wins[d] / max(played[d], 1):>8.1%}   {wins[d]} / {played[d]}")
    out(f"\n  draws (>{args.cap} turns): {draws} ({draws / args.games:.1%})")
    out(f"  first-player win rate:  {first_wins / max(decided, 1):.1%}")
    line = f"  avg turns: {statistics.mean(turns):.1f}"
    if final_lps:
        line += f"   avg winner LP left: {statistics.mean(final_lps):.0f}"
    out(line)

    def top(key, label, limit=8):
        out(f"\n{label}:")
        items = [(n, c) for (k, n), c in usage.items() if k == key]
        for name, cnt in sorted(items, key=lambda x: -x[1])[:limit]:
            out(f"    {name:<24} {cnt}x")
        if not items:
            out("    (none)")

    top("summon", "Most summoned monsters")
    top("spell", "Spells played")
    top("trap_act", "Trap activations")


if __name__ == "__main__":
    main()

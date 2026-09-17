"""Build cards.json + download sprites from PokeAPI.

Run: python fetch_cards.py   (needs internet; output is offline-ready)
Python port of fetch_cards.mjs — same card data, same sprites.
"""

import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

IMG_DIR = Path("img")
CARDS_FILE = Path("cards.json")

DECKS = {
    # 14 monsters + 4 spells + 2 traps each
    "flare": [
        "charmander", "charmeleon", "charizard",
        "vulpix", "ponyta", "flareon", "magmar", "moltres",
        "pikachu", "raichu", "electabuzz", "jolteon", "zapdos", "hitmonlee",
        "thunderbolt_tm", "flamethrower_tm", "x_attack", "poke_ball",
        "protect_tm", "self_destruct_tm",
    ],
    "tide": [
        "squirtle", "wartortle", "blastoise", "vaporeon", "lapras",
        "gyarados", "bulbasaur", "venusaur", "exeggutor",
        "abra", "alakazam", "snorlax", "onix", "dragonite",
        "potion", "full_restore", "rare_candy", "hyper_beam_tm",
        "protect_tm", "counter_tm",
    ],
}

# spell & trap cards — hand-designed, sprites from the PokeAPI sprites repo
SPRITE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/"
SPECIAL = [
    {"id": "potion", "name": "Potion", "kind": "spell", "type": "normal",
     "sprite": "items/potion.png",
     "effect": {"type": "heal", "value": 800},
     "text": "Gain 800 LP."},
    {"id": "full_restore", "name": "Full Restore", "kind": "spell", "type": "normal",
     "sprite": "items/full-restore.png",
     "effect": {"type": "heal", "value": 1500},
     "text": "Gain 1500 LP."},
    {"id": "rare_candy", "name": "Rare Candy", "kind": "spell", "type": "normal",
     "sprite": "items/rare-candy.png",
     "effect": {"type": "draw", "value": 2},
     "text": "Draw 2 cards."},
    {"id": "poke_ball", "name": "Poke Ball", "kind": "spell", "type": "normal",
     "sprite": "items/poke-ball.png",
     "effect": {"type": "draw", "value": 1},
     "text": "Draw 1 card."},
    {"id": "x_attack", "name": "X Attack", "kind": "spell", "type": "fighting",
     "sprite": "items/x-attack.png",
     "effect": {"type": "buff", "value": 600},
     "text": "Equip: a monster you control gains 600 ATK while equipped."},
    {"id": "thunderbolt_tm", "name": "TM24 Thunderbolt", "kind": "spell", "type": "electric",
     "sprite": "items/tm-electric.png",
     "effect": {"type": "burn", "value": 800},
     "text": "Deal 800 damage to your opponent."},
    {"id": "flamethrower_tm", "name": "TM35 Flamethrower", "kind": "spell", "type": "fire",
     "sprite": "items/tm-fire.png",
     "effect": {"type": "burn", "value": 600},
     "text": "Deal 600 damage to your opponent."},
    {"id": "hyper_beam_tm", "name": "TM15 Hyper Beam", "kind": "spell", "type": "normal",
     "sprite": "items/tm-normal.png",
     "effect": {"type": "destroy"},
     "text": "Destroy your opponent's weakest monster."},
    {"id": "protect_tm", "name": "TM17 Protect", "kind": "trap", "type": "normal",
     "sprite": "items/tm-normal.png",
     "effect": {"type": "negate"},
     "text": "Trap: negates an attack."},
    {"id": "self_destruct_tm", "name": "TM36 Self-Destruct", "kind": "trap", "type": "normal",
     "sprite": "items/tm-normal.png",
     "effect": {"type": "destroy_atk"},
     "text": "Trap: destroys the attacking monster."},
    {"id": "counter_tm", "name": "TM18 Counter", "kind": "trap", "type": "fighting",
     "sprite": "items/tm-fighting.png",
     "effect": {"type": "counter"},
     "text": "Trap: negates an attack and deals damage equal to half the attacker's ATK."},
]

# primary type -> card effect
TYPE_EFFECT = {
    "fire":     {"trigger": "on_summon", "type": "burn", "value": 400},
    "electric": {"trigger": "on_summon", "type": "burn", "value": 300},
    "water":    {"trigger": "on_summon", "type": "heal", "value": 500},
    "grass":    {"trigger": "on_summon", "type": "heal", "value": 400},
    "fairy":    {"trigger": "on_summon", "type": "heal", "value": 400},
    "psychic":  {"trigger": "on_summon", "type": "draw", "value": 1},
    "fighting": {"trigger": "passive", "type": "piercing"},
    "dragon":   {"trigger": "passive", "type": "piercing"},
}
LEGENDARY_AURA = {"trigger": "passive", "type": "aura_atk", "value": 250}
LEGENDARY_BST = 580

EFFECT_TEXT = {
    "burn": lambda v: f"On summon: deal {v} damage to your opponent.",
    "heal": lambda v: f"On summon: gain {v} LP.",
    "draw": lambda v: f"On summon: draw {v} card(s).",
    "piercing": lambda v: "Piercing: deals excess damage when destroying a defense-position monster.",
    "aura_atk": lambda v: f"Legendary presence: your other monsters gain {v} ATK.",
}


def scale(stat: int) -> int:
    return round((stat * 18) / 50) * 50


def title(s: str) -> str:
    return "-".join(w[0].upper() + w[1:] for w in s.split("-"))


def to_card(p: dict) -> dict:
    def stat(n: str) -> int:
        return next(s["base_stat"] for s in p["stats"] if s["stat"]["name"] == n)

    bst = sum(s["base_stat"] for s in p["stats"])
    ptype = p["types"][0]["type"]["name"]
    effect = LEGENDARY_AURA if bst >= LEGENDARY_BST else TYPE_EFFECT.get(ptype)
    return {
        "id": p["name"],
        "name": title(p["name"]),
        "kind": "monster",
        "atk": scale(max(stat("attack"), stat("special-attack"))),
        "defense": scale(max(stat("defense"), stat("special-defense"))),
        "level": max(1, min(8, round((bst - 280) / 45))),
        "type": ptype,
        "img": f"img/{p['name']}.png",
        "effect": effect,
        "text": EFFECT_TEXT[effect["type"]](effect.get("value", 0)) if effect else "",
    }


UA = {"User-Agent": "YuGiPoke/1.0 (card game generator)"}


def get_json(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        return json.loads(r.read())


def download(url: str, path: Path) -> None:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        path.write_bytes(r.read())


def main() -> None:
    special_ids = {c["id"] for c in SPECIAL}
    species = list(dict.fromkeys(
        i for ids in DECKS.values() for i in ids if i not in special_ids))
    IMG_DIR.mkdir(exist_ok=True)

    cards = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(
            lambda n: get_json(f"https://pokeapi.co/api/v2/pokemon/{n}"), species))
    for p in results:
        sprites = p["sprites"]
        img_url = (sprites.get("other", {}).get("official-artwork", {}).get("front_default")
                   or sprites.get("front_default"))
        if img_url:
            download(img_url, IMG_DIR / f"{p['name']}.png")
        c = to_card(p)
        cards.append(c)
        print(f"+ {p['name']}  atk={c['atk']} def={c['defense']} lv={c['level']}")

    # spell/trap sprites (tiny pixel art — upscale with image-rendering: pixelated)
    for c in SPECIAL:
        download(SPRITE_BASE + c["sprite"], IMG_DIR / f"{c['id']}.png")
        cards.append({**c, "img": f"img/{c['id']}.png"})
        print(f"+ {c['id']}  [{c['kind']}]")

    CARDS_FILE.write_text(
        json.dumps({"cards": cards, "decks": DECKS}, indent=2) + "\n",
        encoding="utf-8")
    print(f"\nWrote {len(cards)} cards, decks: " +
          ", ".join(f"{k}={len(v)}" for k, v in DECKS.items()))


if __name__ == "__main__":
    main()

"""Card definitions and game-state models, loaded from cards.json."""

import json
import random
from dataclasses import dataclass, field as dc_field
from pathlib import Path

CARDS_FILE = Path(__file__).parent / "cards.json"


@dataclass(frozen=True)
class CardDef:
    """Static card data from cards.json."""
    id: str
    name: str
    atk: int
    defense: int
    level: int
    effect: dict | None
    text: str = ""
    type: str = ""
    img: str = ""
    kind: str = "monster"

    @property
    def tributes_needed(self) -> int:
        if self.level >= 7:
            return 2
        if self.level >= 5:
            return 1
        return 0


@dataclass
class Monster:
    """A card instance on the field."""
    card: CardDef
    position: str = "attack"  # "attack" or "defense"
    summoned_this_turn: bool = True
    attacked_this_turn: bool = False
    position_changed: bool = False
    attacks_left: int = 1
    equipped: list = dc_field(default_factory=list)  # buff spells equipped to this monster


@dataclass
class Player:
    name: str
    lp: int = 4000
    deck: list[CardDef] = dc_field(default_factory=list)
    hand: list[CardDef] = dc_field(default_factory=list)
    field: list[Monster] = dc_field(default_factory=list)
    graveyard: list[CardDef] = dc_field(default_factory=list)
    traps: list[CardDef] = dc_field(default_factory=list)
    normal_summoned: bool = False
    is_ai: bool = False


def load_card_db(path: Path = CARDS_FILE) -> dict[str, CardDef]:
    data = json.loads(path.read_text(encoding="utf-8"))
    db = {}
    for c in data["cards"]:
        db[c["id"]] = CardDef(
            id=c["id"],
            name=c["name"],
            atk=c.get("atk", 0),
            defense=c.get("defense", 0),
            level=c.get("level", 0),
            effect=c.get("effect"),
            text=c.get("text", ""),
            type=c.get("type", ""),
            img=c.get("img", ""),
            kind=c.get("kind", "monster"),
        )
    return db


def load_deck_lists(path: Path = CARDS_FILE) -> dict[str, list[str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["decks"]


def build_deck(deck_ids: list[str], db: dict[str, CardDef]) -> list[CardDef]:
    deck = [db[cid] for cid in deck_ids]
    random.shuffle(deck)
    return deck

// fetch_cards.mjs — build cards.json + download sprites from PokeAPI.
// Run: node fetch_cards.mjs   (needs internet; output is offline-ready)

import { mkdirSync, writeFileSync } from "fs";

const DECKS = {
  // 14 monsters + 4 spells + 2 traps each
  flare: [
    "charmander", "charmeleon", "charizard",
    "vulpix", "ponyta", "flareon", "magmar", "moltres",
    "pikachu", "raichu", "electabuzz", "jolteon", "zapdos", "hitmonlee",
    "thunderbolt_tm", "flamethrower_tm", "x_attack", "poke_ball",
    "protect_tm", "self_destruct_tm",
  ],
  tide: [
    "squirtle", "wartortle", "blastoise", "vaporeon", "lapras",
    "gyarados", "bulbasaur", "venusaur", "exeggutor",
    "abra", "alakazam", "snorlax", "onix", "dragonite",
    "potion", "full_restore", "rare_candy", "hyper_beam_tm",
    "protect_tm", "counter_tm",
  ],
};

// spell & trap cards — hand-designed, sprites from the PokeAPI sprites repo
const SPRITE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/";
const SPECIAL = [
  { id: "potion", name: "Potion", kind: "spell", type: "normal",
    sprite: "items/potion.png",
    effect: { type: "heal", value: 800 },
    text: "Gain 800 LP." },
  { id: "full_restore", name: "Full Restore", kind: "spell", type: "normal",
    sprite: "items/full-restore.png",
    effect: { type: "heal", value: 1500 },
    text: "Gain 1500 LP." },
  { id: "rare_candy", name: "Rare Candy", kind: "spell", type: "normal",
    sprite: "items/rare-candy.png",
    effect: { type: "draw", value: 2 },
    text: "Draw 2 cards." },
  { id: "poke_ball", name: "Poke Ball", kind: "spell", type: "normal",
    sprite: "items/poke-ball.png",
    effect: { type: "draw", value: 1 },
    text: "Draw 1 card." },
  { id: "x_attack", name: "X Attack", kind: "spell", type: "fighting",
    sprite: "items/x-attack.png",
    effect: { type: "buff", value: 600 },
    text: "Equip: a monster you control gains 600 ATK while equipped." },
  { id: "thunderbolt_tm", name: "TM24 Thunderbolt", kind: "spell", type: "electric",
    sprite: "items/tm-electric.png",
    effect: { type: "burn", value: 800 },
    text: "Deal 800 damage to your opponent." },
  { id: "flamethrower_tm", name: "TM35 Flamethrower", kind: "spell", type: "fire",
    sprite: "items/tm-fire.png",
    effect: { type: "burn", value: 600 },
    text: "Deal 600 damage to your opponent." },
  { id: "hyper_beam_tm", name: "TM15 Hyper Beam", kind: "spell", type: "normal",
    sprite: "items/tm-normal.png",
    effect: { type: "destroy" },
    text: "Destroy your opponent's weakest monster." },
  { id: "protect_tm", name: "TM17 Protect", kind: "trap", type: "normal",
    sprite: "items/tm-normal.png",
    effect: { type: "negate" },
    text: "Trap: negates an attack." },
  { id: "self_destruct_tm", name: "TM36 Self-Destruct", kind: "trap", type: "normal",
    sprite: "items/tm-normal.png",
    effect: { type: "destroy_atk" },
    text: "Trap: destroys the attacking monster." },
  { id: "counter_tm", name: "TM18 Counter", kind: "trap", type: "fighting",
    sprite: "items/tm-fighting.png",
    effect: { type: "counter" },
    text: "Trap: negates an attack and deals damage equal to half the attacker's ATK." },
];

// primary type → card effect
const TYPE_EFFECT = {
  fire:     { trigger: "on_summon", type: "burn", value: 400 },
  electric: { trigger: "on_summon", type: "burn", value: 300 },
  water:    { trigger: "on_summon", type: "heal", value: 500 },
  grass:    { trigger: "on_summon", type: "heal", value: 400 },
  fairy:    { trigger: "on_summon", type: "heal", value: 400 },
  psychic:  { trigger: "on_summon", type: "draw", value: 1 },
  fighting: { trigger: "passive", type: "piercing" },
  dragon:   { trigger: "passive", type: "piercing" },
};
const LEGENDARY_AURA = { trigger: "passive", type: "aura_atk", value: 250 };
const LEGENDARY_BST = 580;

const EFFECT_TEXT = {
  burn: v => `On summon: deal ${v} damage to your opponent.`,
  heal: v => `On summon: gain ${v} LP.`,
  draw: v => `On summon: draw ${v} card(s).`,
  piercing: () => "Piercing: deals excess damage when destroying a defense-position monster.",
  aura_atk: v => `Legendary presence: your other monsters gain ${v} ATK.`,
};

const scale = stat => Math.round((stat * 18) / 50) * 50;
const title = s => s.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join("-");

function toCard(p) {
  const stat = n => p.stats.find(s => s.stat.name === n).base_stat;
  const bst = p.stats.reduce((s, x) => s + x.base_stat, 0);
  const type = p.types[0].type.name;
  const effect = bst >= LEGENDARY_BST ? LEGENDARY_AURA : (TYPE_EFFECT[type] || null);
  return {
    id: p.name,
    name: title(p.name),
    kind: "monster",
    atk: scale(Math.max(stat("attack"), stat("special-attack"))),
    defense: scale(Math.max(stat("defense"), stat("special-defense"))),
    level: Math.max(1, Math.min(8, Math.round((bst - 280) / 45))),
    type,
    img: `img/${p.name}.png`,
    effect,
    text: effect ? EFFECT_TEXT[effect.type](effect.value) : "",
  };
}

async function getPokemon(name) {
  const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

async function download(url, path) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`img ${url}: HTTP ${r.status}`);
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
}

const specialIds = new Set(SPECIAL.map(c => c.id));
const species = [...new Set([...DECKS.flare, ...DECKS.tide])]
  .filter(id => !specialIds.has(id));
mkdirSync("img", { recursive: true });

const cards = [];
const BATCH = 8;
for (let i = 0; i < species.length; i += BATCH) {
  const batch = species.slice(i, i + BATCH);
  const results = await Promise.all(batch.map(getPokemon));
  for (const p of results) {
    const imgUrl = p.sprites.other["official-artwork"].front_default
      || p.sprites.front_default;
    if (imgUrl) await download(imgUrl, `img/${p.name}.png`);
    cards.push(toCard(p));
    console.log(`✓ ${p.name}  atk=${cards.at(-1).atk} def=${cards.at(-1).defense} lv=${cards.at(-1).level}`);
  }
}

// spell/trap sprites (tiny pixel art — upscale with image-rendering: pixelated)
for (const c of SPECIAL) {
  await download(SPRITE_BASE + c.sprite, `img/${c.id}.png`);
  cards.push({ ...c, img: `img/${c.id}.png` });
  console.log(`✓ ${c.id}  [${c.kind}]`);
}

const decks = DECKS;

writeFileSync("cards.json",
  JSON.stringify({ cards, decks }, null, 2) + "\n");
console.log(`\nWrote ${cards.length} cards, decks: ` +
  Object.entries(decks).map(([k, v]) => `${k}=${v.length}`).join(", "));

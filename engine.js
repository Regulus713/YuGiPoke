// engine.js — core duel logic (browser port of engine.py)

export const STARTING_LP = 4000;
export const STARTING_HAND = 4;
export const MAX_FIELD = 5;
export const HAND_LIMIT = 6;
export const MAX_TRAPS = 3;

export class Duel {
  constructor(p1, p2) {
    this.players = [p1, p2];
    this.turnIndex = 0;
    this.turnNumber = 1;
    this.winner = null;
    this.loserReason = "";
    this.logs = [];
    this.events = [];   // FX event queue — drained by the UI on each render
  }
  get current() { return this.players[this.turnIndex % 2]; }
  get opponent() { return this.players[(this.turnIndex + 1) % 2]; }
  other(p) { return this.players[0] === p ? this.players[1] : this.players[0]; }
}

export function makePlayer(name, deck, isAI = false) {
  return {
    name, lp: STARTING_LP, deck,
    hand: [], field: [], graveyard: [], traps: [],
    normalSummoned: false, isAI,
  };
}

export function makeMonster(card, position) {
  return {
    card, position,
    summonedThisTurn: true,
    attackedThisTurn: false,
    positionChanged: false,
    attacksLeft: 1,
    equipped: [],
  };
}

export function tributesNeeded(card) {
  if (card.level >= 7) return 2;
  if (card.level >= 5) return 1;
  return 0;
}

export function log(duel, msg) {
  duel.logs.push(msg);
  if (duel.logs.length > 300) duel.logs.shift();
}

// ---------------------------------------------------------------- helpers

function isAura(m) {
  const e = m.card.effect;
  return !!(e && e.trigger === "passive" && e.type === "aura_atk");
}

function auraStats(owner) {
  let total = 0, sources = 0;
  for (const m of owner.field) {
    const e = m.card.effect;
    if (e && e.trigger === "passive" && e.type === "aura_atk") {
      total += e.value || 0;
      sources++;
    }
  }
  return { total, sources };
}

export function equipBuff(m) {
  return (m.equipped || []).reduce((s, c) => s + (c.effect?.value || 0), 0);
}

export function effectiveAtk(duel, owner, m) {
  const { total, sources } = auraStats(owner);
  const buff = equipBuff(m);
  if (!isAura(m)) return m.card.atk + total + buff;
  // an aura monster benefits from other aura monsters but not itself
  const aura = sources > 1 ? m.card.atk + total - (m.card.effect.value || 0) : m.card.atk;
  return aura + buff;
}

export function hasPiercing(m) {
  const e = m.card.effect;
  return !!(e && e.trigger === "passive" && e.type === "piercing");
}

export function checkGameOver(duel) {
  for (const p of duel.players) {
    if (p.lp <= 0) {
      p.lp = 0;
      duel.winner = duel.other(p);
      duel.loserReason = `${p.name}'s LP reached 0.`;
    }
  }
}

export function drawCards(duel, p, n = 1) {
  let drew = 0;
  for (let i = 0; i < n; i++) {
    if (!p.deck.length) {
      duel.winner = duel.other(p);
      duel.loserReason = `${p.name} could not draw — decked out.`;
      return;
    }
    p.hand.push(p.deck.pop());
    drew++;
  }
  if (drew) duel.events.push({ t: "draw", owner: p, n: drew });
}

export function destroy(duel, owner, m) {
  const idx = owner.field.indexOf(m);
  owner.field.splice(idx, 1);
  owner.graveyard.push(m.card, ...(m.equipped || []));
  duel.events.push({ t: "destroy", owner, m, idx });
  log(duel, `${m.card.name} is destroyed!`);
  triggerEffect(duel, owner, m, "on_destroy");
}

export function triggerEffect(duel, owner, m, when) {
  const eff = m.card.effect;
  if (!eff || eff.trigger !== when) return;
  duel.events.push({ t: "effect", owner, m });
  const opp = duel.other(owner);
  const value = eff.value || 0;
  if (eff.type === "burn") {
    opp.lp -= value;
    log(duel, `Effect: ${m.card.name} deals ${value} damage to ${opp.name}!`);
  } else if (eff.type === "heal") {
    owner.lp += value;
    log(duel, `Effect: ${owner.name} gains ${value} LP!`);
  } else if (eff.type === "draw") {
    log(duel, `Effect: ${owner.name} draws ${value} card(s)!`);
    drawCards(duel, owner, value);
  }
  checkGameOver(duel);
}

// ---------------------------------------------------------------- turn flow

export function startTurn(duel) {
  const p = duel.current;
  p.normalSummoned = false;
  for (const m of p.field) {
    m.summonedThisTurn = false;
    m.attackedThisTurn = false;
    m.positionChanged = false;
    m.attacksLeft = 1;
  }
  // The player going first skips their very first draw.
  if (!(duel.turnNumber === 1 && duel.turnIndex === 0)) drawCards(duel, p, 1);
}

export function discard(duel, p, handIdx) {
  const card = p.hand.splice(handIdx, 1)[0];
  p.graveyard.push(card);
  log(duel, `${p.name} discards ${card.name} (hand limit ${HAND_LIMIT}).`);
  return card;
}

export function endTurn(duel) {
  duel.turnIndex++;
  if (duel.turnIndex % 2 === 0) duel.turnNumber++;
}

// ---------------------------------------------------------------- spells & traps

export function playSpell(duel, p, handIdx, targetIdx = null) {
  const card = p.hand[handIdx];
  if (!card || card.kind !== "spell") return [false, "Not a spell card."];
  const opp = duel.other(p);
  const e = card.effect;

  if (e.type === "buff") {
    const m = p.field[targetIdx];
    if (!m) return [false, "Choose one of your monsters."];
  } else if (e.type === "destroy") {
    if (!opp.field.length) return [false, "Opponent has no monsters."];
  }

  p.hand.splice(handIdx, 1);
  duel.events.push({ t: "spell", owner: p, card });
  log(duel, `${p.name} plays ${card.name}!`);

  if (e.type === "buff") {
    // equip: the card stays attached to the monster until it leaves the field
    const m = p.field[targetIdx];
    m.equipped.push(card);
    log(duel, `${card.name} equipped to ${m.card.name} (+${e.value} ATK).`);
  } else {
    p.graveyard.push(card);
    if (e.type === "heal") {
      p.lp += e.value;
      log(duel, `${p.name} gains ${e.value} LP.`);
    } else if (e.type === "burn") {
      opp.lp -= e.value;
      log(duel, `${opp.name} takes ${e.value} damage!`);
    } else if (e.type === "draw") {
      drawCards(duel, p, e.value);
    } else if (e.type === "destroy") {
      let wi = 0;
      opp.field.forEach((m, i) => {
        if (effectiveAtk(duel, opp, m) < effectiveAtk(duel, opp, opp.field[wi])) wi = i;
      });
      destroy(duel, opp, opp.field[wi]);
    }
  }
  checkGameOver(duel);
  return [true, ""];
}

export function setTrap(duel, p, handIdx) {
  const card = p.hand[handIdx];
  if (!card || card.kind !== "trap") return [false, "Not a trap card."];
  if (p.traps.length >= MAX_TRAPS) return [false, "Trap zone is full (3)."];
  p.hand.splice(handIdx, 1);
  p.traps.push(card);
  duel.events.push({ t: "set", owner: p });
  log(duel, `${p.name} sets a trap face-down.`);
  return [true, ""];
}

function resolveTrap(duel, p, m) {
  // first set trap triggers when opponent declares an attack
  const opp = duel.other(p);
  if (!opp.traps.length) return false;
  const trap = opp.traps.shift();
  opp.graveyard.push(trap);
  duel.events.push({ t: "trap", owner: opp, card: trap });
  log(duel, `${opp.name}'s trap ${trap.name} activates!`);
  const te = trap.effect.type;
  if (te === "negate") {
    log(duel, `${m.card.name}'s attack is negated!`);
  } else if (te === "destroy_atk") {
    destroy(duel, p, m);
  } else if (te === "counter") {
    const dmg = Math.round(effectiveAtk(duel, p, m) / 100) * 50;
    p.lp -= dmg;
    log(duel, `${p.name} takes ${dmg} damage!`);
    checkGameOver(duel);
  }
  return true;  // attack is consumed either way
}

// ---------------------------------------------------------------- actions

export function canSummon(duel, p, card) {
  if (p.normalSummoned) return [false, "You have already used your normal summon this turn."];
  if (p.field.length >= MAX_FIELD) return [false, "Your field is full."];
  if (tributesNeeded(card) > p.field.length)
    return [false, `${card.name} requires ${tributesNeeded(card)} tribute(s).`];
  return [true, ""];
}

export function summon(duel, p, handIdx, position, tributeIdxs = []) {
  const card = p.hand[handIdx];
  const [ok] = canSummon(duel, p, card);
  if (!ok) return false;
  const needed = tributesNeeded(card);
  if (tributeIdxs.length !== needed) return false;

  p.hand.splice(handIdx, 1);
  for (const i of [...tributeIdxs].sort((a, b) => b - a)) {
    const tributed = p.field.splice(i, 1)[0];
    p.graveyard.push(tributed.card, ...(tributed.equipped || []));
    log(duel, `${p.name} tributes ${tributed.card.name}.`);
  }

  const m = makeMonster(card, position);
  p.field.push(m);
  p.normalSummoned = true;
  duel.events.push({ t: "summon", owner: p, m });
  log(duel, `${p.name} summons ${card.name} in ${position} position!`);
  triggerEffect(duel, p, m, "on_summon");
  return true;
}

export function switchPosition(duel, p, fieldIdx) {
  const m = p.field[fieldIdx];
  if (m.summonedThisTurn)
    return [false, `${m.card.name} was summoned this turn and can't change position.`];
  if (m.attackedThisTurn)
    return [false, `${m.card.name} already attacked this turn.`];
  if (m.positionChanged)
    return [false, `${m.card.name} already changed position this turn.`];
  m.position = m.position === "attack" ? "defense" : "attack";
  m.positionChanged = true;
  duel.events.push({ t: "switch", owner: p, m });
  if (m.position === "defense") m.attacksLeft = 0;
  log(duel, `${p.name} switches ${m.card.name} to ${m.position} position.`);
  return [true, ""];
}

export function attack(duel, p, fieldIdx, targetIdx = null) {
  const m = p.field[fieldIdx];
  const opp = duel.other(p);
  if (m.position !== "attack")
    return [false, `${m.card.name} is in defense position.`];
  if (m.attacksLeft <= 0)
    return [false, `${m.card.name} has already attacked.`];
  if (targetIdx === null && opp.field.length)
    return [false, "Opponent has monsters — you must attack one of them."];

  const a = effectiveAtk(duel, p, m);
  const t = targetIdx === null ? null : opp.field[targetIdx];
  m.attacksLeft = 0;
  m.attackedThisTurn = true;
  duel.events.push({ t: "attack", owner: p, m, target: t, tIdx: targetIdx, direct: targetIdx === null });

  // a set trap fires on the attack declaration
  if (opp.traps.length && resolveTrap(duel, p, m)) return [true, ""];

  if (targetIdx === null) {
    opp.lp -= a;
    log(duel, `${m.card.name} attacks ${opp.name} directly for ${a} damage!`);
    checkGameOver(duel);
    return [true, ""];
  }
  if (t.position === "attack") {
    const d = effectiveAtk(duel, opp, t);
    log(duel, `${m.card.name} (${a} ATK) attacks ${t.card.name} (${d} ATK)!`);
    if (a > d) {
      destroy(duel, opp, t);
      opp.lp -= a - d;
      log(duel, `${opp.name} takes ${a - d} damage.`);
    } else if (a < d) {
      destroy(duel, p, m);
      p.lp -= d - a;
      log(duel, `${p.name} takes ${d - a} damage.`);
    } else {
      destroy(duel, opp, t);
      destroy(duel, p, m);
      log(duel, "Both monsters are destroyed!");
    }
  } else {
    const d = t.card.defense;
    log(duel, `${m.card.name} (${a} ATK) attacks ${t.card.name} (${d} DEF)!`);
    if (a > d) {
      destroy(duel, opp, t);
      if (hasPiercing(m)) {
        opp.lp -= a - d;
        log(duel, `Piercing! ${opp.name} takes ${a - d} damage.`);
      }
    } else if (a < d) {
      p.lp -= d - a;
      log(duel, `Attack fails — ${p.name} takes ${d - a} damage.`);
    } else {
      log(duel, "Neither monster is destroyed.");
    }
  }
  checkGameOver(duel);
  return [true, ""];
}

export function weakestHandIndex(p) {
  let best = 0, bestScore = Infinity;
  p.hand.forEach((c, i) => {
    // non-monsters get a pseudo-score so they're not always kept/dumped first
    const s = c.kind === "monster" || c.atk != null ? c.atk + c.defense : 500;
    if (s < bestScore) { bestScore = s; best = i; }
  });
  return best;
}

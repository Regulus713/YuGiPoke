// ai.js — heuristic AI (browser port of ai.py)

import * as E from "./engine.js";

const DELAY = 800;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// refresh: () => void — called after each action so the UI updates
export async function takeTurn(duel, me, refresh) {
  await specialPhase(duel, me, refresh);
  if (duel.winner) return;
  mainPhase(duel, me);
  refresh();
  await sleep(DELAY);
  if (duel.winner) return;
  await battlePhase(duel, me, refresh);
  if (duel.winner) return;
  cleanupPhase(duel, me);
  refresh();
  await sleep(DELAY);
}

// ---------------------------------------------------------------- phases

// play useful spells and set traps before summoning
async function specialPhase(duel, me, refresh) {
  for (let i = me.hand.length - 1; i >= 0; i--) {
    if (duel.winner) return;
    const c = me.hand[i];
    if (c.kind === "spell" && spellUseful(duel, me, c)) {
      const tIdx = c.effect.type === "buff" ? strongestFieldIdx(duel, me) : null;
      E.playSpell(duel, me, i, tIdx);
      refresh();
      await sleep(DELAY);
    } else if (c.kind === "trap" && me.traps.length < 2) {
      E.setTrap(duel, me, i);
      refresh();
      await sleep(Math.round(DELAY * 0.6));
    }
  }
}

function spellUseful(duel, me, c) {
  const opp = duel.other(me);
  switch (c.effect.type) {
    case "heal": return me.lp <= 2500;
    case "burn": return true;
    case "draw": return me.hand.length < E.HAND_LIMIT;
    case "buff": return me.field.length > 0;
    case "destroy": return opp.field.length > 0;
    default: return false;
  }
}

function strongestFieldIdx(duel, me) {
  let bi = -1, ba = -1;
  me.field.forEach((m, i) => {
    const a = E.effectiveAtk(duel, me, m);
    if (a > ba) { ba = a; bi = i; }
  });
  return bi;
}

function mainPhase(duel, me) {
  if (me.normalSummoned || !me.hand.length || me.field.length >= E.MAX_FIELD) return;
  const opp = duel.other(me);
  const bestEnemyAtk = Math.max(
    0,
    ...opp.field.filter(m => m.position === "attack")
                .map(m => E.effectiveAtk(duel, opp, m))
  );

  let bestIdx = -1, bestScore = -1;
  me.hand.forEach((card, i) => {
    if (card.kind !== "monster") return;
    const [ok] = E.canSummon(duel, me, card);
    if (!ok) return;
    const score = summonScore(duel, me, card);
    if (score > bestScore) { bestIdx = i; bestScore = score; }
  });
  if (bestIdx < 0) return;

  const card = me.hand[bestIdx];
  const tributes = pickTributes(duel, me, card);
  if (tributes === null) return;

  const position = (!opp.field.length || card.atk > bestEnemyAtk) ? "attack" : "defense";
  E.summon(duel, me, bestIdx, position, tributes);
}

function summonScore(duel, me, card) {
  let score = card.atk + card.defense * 0.3;
  const eff = card.effect;
  if (eff) {
    if (eff.type === "burn") score += (eff.value || 0) * 0.6;
    else if (eff.type === "draw" || eff.type === "heal") score += (eff.value || 1) * 200;
    else if (eff.type === "piercing" || eff.type === "aura_atk") score += 150;
  }
  if (E.tributesNeeded(card)) {
    const cost = tributeCost(duel, me, E.tributesNeeded(card));
    if (card.atk < cost * 0.85) return -1;
    score -= cost * 0.5;
  }
  return score;
}

function tributeCost(duel, me, needed) {
  const sorted = [...me.field].sort((a, b) => E.effectiveAtk(duel, me, a) - E.effectiveAtk(duel, me, b));
  return sorted.slice(0, needed).reduce((s, m) => s + E.effectiveAtk(duel, me, m), 0);
}

function pickTributes(duel, me, card) {
  const needed = E.tributesNeeded(card);
  if (needed === 0) return [];
  if (needed > me.field.length) return null;
  const idxs = me.field.map((_, i) => i)
    .sort((a, b) => E.effectiveAtk(duel, me, me.field[a]) - E.effectiveAtk(duel, me, me.field[b]))
    .slice(0, needed);
  const cost = idxs.reduce((s, i) => s + E.effectiveAtk(duel, me, me.field[i]), 0);
  return card.atk >= cost * 0.85 ? idxs : null;
}

async function battlePhase(duel, me, refresh) {
  const opp = duel.other(me);
  for (;;) {
    if (duel.winner) return;
    let acted = false;
    for (let i = 0; i < me.field.length; i++) {
      const m = me.field[i];
      if (m.position !== "attack" || m.attacksLeft <= 0) continue;
      const target = pickTarget(duel, me, m);
      if (target === "skip") continue;
      E.attack(duel, me, i, target);
      refresh();
      await sleep(DELAY);
      acted = true;
      break; // field may have changed — rescan
    }
    if (!acted) return;
  }
}

function pickTarget(duel, me, m) {
  const opp = duel.other(me);
  const myAtk = E.effectiveAtk(duel, me, m);
  if (!opp.field.length) return null; // direct attack

  let bestIdx = -1, bestScore = 0;
  opp.field.forEach((t, j) => {
    let score = 0;
    if (t.position === "attack") {
      const tAtk = E.effectiveAtk(duel, opp, t);
      if (myAtk > tAtk) {
        score = (myAtk - tAtk) + tAtk * 0.5 + 100;
      } else if (myAtk === tAtk && t.card.atk >= myAtk) {
        score = tAtk * 0.3; // favorable trade only if theirs is big
      }
    } else {
      if (myAtk > t.card.defense) {
        const pierce = E.hasPiercing(m) ? myAtk - t.card.defense : 0;
        score = 150 + pierce + t.card.defense * 0.15;
      }
    }
    if (score > bestScore) { bestIdx = j; bestScore = score; }
  });
  return bestIdx >= 0 ? bestIdx : "skip";
}

function cleanupPhase(duel, me) {
  const opp = duel.other(me);
  const bestEnemyAtk = Math.max(
    0,
    ...opp.field.filter(m => m.position === "attack")
                .map(m => E.effectiveAtk(duel, opp, m))
  );
  me.field.forEach((m, i) => {
    if (m.position === "attack" && !m.summonedThisTurn && !m.attackedThisTurn) {
      if (E.effectiveAtk(duel, me, m) < bestEnemyAtk && m.card.defense >= 1200) {
        E.switchPosition(duel, me, i);
      }
    }
  });
}

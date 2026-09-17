// ui.js — rendering, input handling, and game flow for the browser version

import * as E from "./engine.js";
import * as AI from "./ai.js";
import { sfx, soundEnabled, setSoundEnabled } from "./audio.js";

const $ = s => document.querySelector(s);
const el = (tag, cls, html) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
};

let db = {};
let deckLists = {};
let duel = null;
let phase = "main";              // "main" | "battle" | "main2"
let selHand = -1;
let selField = -1;
let attackFrom = -1;
let tributePick = null;          // {handIdx, position, needed, picks:Set}
let spellPick = null;            // {handIdx} — buff spells pick a target monster
let endTurnResolve = null;
let busy = false;                // AI/overlay running — lock board input
let gameOverShown = false;

const lastLp = new Map();        // player -> last rendered LP, for delta flashes

const PHASE_NAMES = { main: "Main Phase", battle: "Battle Phase", main2: "Main Phase 2" };

// ---------------------------------------------------------------- helpers

// card frame tint by pokemon type, fallback to a hash of the id
const TYPE_HUE = {
  fire: 12, water: 208, grass: 115, electric: 48, psychic: 285, fairy: 320,
  fighting: 18, dragon: 265, normal: 35, ground: 30, rock: 32, flying: 195,
  bug: 80, poison: 300, ghost: 255, ice: 190, dark: 260, steel: 210,
};

function hueFor(card) {
  if (card.type && TYPE_HUE[card.type] != null) return TYPE_HUE[card.type];
  let h = 0;
  for (const c of card.id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function monogram(name) {
  return name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function viewer() {
  if (!duel) return null;
  return duel.players.find(p => !p.isAI);
}

function notice(msg) {
  const n = $("#notice");
  n.textContent = msg;
  n.classList.add("show");
  clearTimeout(notice._t);
  notice._t = setTimeout(() => n.classList.remove("show"), 3200);
}

function overlay(html) {
  const o = $("#overlay");
  o.innerHTML = `<div class="panel">${html}</div>`;
  o.classList.add("show");
  return o.firstElementChild;
}

function hideOverlay() {
  $("#overlay").classList.remove("show");
  $("#overlay").innerHTML = "";
}

// ---------------------------------------------------------------- fx layer

function zoneOf(owner) {
  return owner === viewer() ? "#my-field" : "#opp-field";
}

function monsterElAt(owner, m) {
  const i = owner.field.indexOf(m);
  if (i < 0) return null;
  return $(zoneOf(owner)).children[i]?.firstElementChild || null;
}

function slotRect(owner, idx) {
  const slot = $(zoneOf(owner)).children[Math.min(idx, E.MAX_FIELD - 1)];
  return slot.getBoundingClientRect();
}

function flyText(x, y, text, cls) {
  const d = el("div", "flytext " + cls, text);
  d.style.left = x + "px";
  d.style.top = y + "px";
  $("#fx").appendChild(d);
  setTimeout(() => d.remove(), 1000);
}

function slashFx(rect) {
  const s = el("div", "slash");
  s.style.left = (rect.left + rect.width / 2 - 45) + "px";
  s.style.top = (rect.top + rect.height / 2) + "px";
  $("#fx").appendChild(s);
  setTimeout(() => s.remove(), 320);
}

function ghostFx(ev) {
  const r = slotRect(ev.owner, ev.idx);
  const g = monsterEl(ev.m, ev.owner, ev.idx, false);
  g.classList.add("ghost");
  Object.assign(g.style, {
    position: "fixed", left: r.left + "px", top: r.top + "px",
    width: r.width + "px", height: r.height + "px", margin: 0,
  });
  $("#fx").appendChild(g);
  setTimeout(() => g.remove(), 650);
}

function shake() {
  const b = $("#board");
  b.classList.remove("shake");
  void b.offsetWidth;
  b.classList.add("shake");
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");
}

function attackFx(ev) {
  const defender = duel.other(ev.owner);
  let targetRect = null;
  if (ev.target) {
    // slot exists whether the target survived or was destroyed
    targetRect = slotRect(defender, ev.tIdx);
  } else {
    const bar = ev.owner === viewer() ? $("#opp-bar") : $("#me-bar");
    targetRect = bar.getBoundingClientRect();
  }
  const atkEl = monsterElAt(ev.owner, ev.m);
  if (atkEl && targetRect) {
    const a = atkEl.getBoundingClientRect();
    const dx = (targetRect.left + targetRect.width / 2) - (a.left + a.width / 2);
    const dy = (targetRect.top + targetRect.height / 2) - (a.top + a.height / 2);
    atkEl.animate([
      { transform: "translate(0,0)" },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55}px)`, offset: 0.35 },
      { transform: "translate(0,0)" },
    ], { duration: 340, easing: "ease-in-out" });
  }
  if (ev.target && targetRect) slashFx(targetRect);
}

function flashCardFx(card) {
  const c = cardEl(card);
  c.className = "card flash " + (card.kind || "monster");
  c.onclick = null;
  $("#fx").appendChild(c);
  setTimeout(() => c.remove(), 850);
}

function trapRowOf(owner) {
  return owner === viewer() ? "#my-traps" : "#opp-traps";
}

function drainEvents() {
  for (const ev of duel.events) {
    if (ev.t === "summon") {
      monsterElAt(ev.owner, ev.m)?.classList.add("enter");
      sfx.summon();
    } else if (ev.t === "switch") {
      monsterElAt(ev.owner, ev.m)?.classList.add("switchanim");
      sfx.switch();
    } else if (ev.t === "effect") {
      monsterElAt(ev.owner, ev.m)?.classList.add("fx-glow");
      sfx.effect();
    } else if (ev.t === "destroy") {
      ghostFx(ev); shake();
      sfx.destroy();
    } else if (ev.t === "attack") {
      attackFx(ev);
      sfx.attack();
    } else if (ev.t === "draw") {
      sfx.draw();
    } else if (ev.t === "spell") {
      flashCardFx(ev.card);
      sfx.effect();
    } else if (ev.t === "trap") {
      flashCardFx(ev.card);
      shake();
      sfx.destroy();
    } else if (ev.t === "set") {
      $(trapRowOf(ev.owner)).lastElementChild?.classList.add("enter");
      sfx.draw();
    }
  }
  duel.events.length = 0;
}

function lpDiff(v, opp) {
  for (const p of [v, opp]) {
    const prev = lastLp.has(p) ? lastLp.get(p) : p.lp;
    if (prev !== p.lp) {
      const delta = p.lp - prev;
      const barEl = (p === v ? $("#me-bar") : $("#opp-bar")).querySelector(".lp");
      if (barEl) {
        barEl.classList.remove("lp-down", "lp-up");
        void barEl.offsetWidth;
        barEl.classList.add(delta < 0 ? "lp-down" : "lp-up");
        const r = barEl.getBoundingClientRect();
        flyText(r.left + r.width / 2, r.top - 4, (delta > 0 ? "+" : "") + delta,
                delta < 0 ? "dmg" : "heal");
        if (delta < 0) sfx.hit(); else sfx.heal();
      }
    }
    lastLp.set(p, p.lp);
  }
}

// ---------------------------------------------------------------- cards

function cardEl(card) {
  const kind = card.kind || "monster";
  const d = el("div", "card " + kind);
  const hue = kind === "spell" ? 175 : kind === "trap" ? 325 : hueFor(card);
  d.style.setProperty("--hue", hue);
  const art = card.img
    ? `<img class="c-img" src="${card.img}" alt="${card.name}" draggable="false">`
    : `<span class="c-glyph">${monogram(card.name)}</span>`;
  if (kind === "monster") {
    const trib = E.tributesNeeded(card);
    d.innerHTML = `
      <div class="c-name">${card.name}</div>
      <div class="c-art">
        ${art}
        <span class="c-stars">${"★".repeat(card.level)}</span>
      </div>
      <div class="c-stats">
        <span class="atk">ATK ${card.atk}</span><span class="def">DEF ${card.defense}</span>
      </div>
      ${card.text ? `<div class="c-text">${card.text}</div>` : ""}
      ${trib ? `<div class="c-trib">${trib} tribute${trib > 1 ? "s" : ""}</div>` : ""}`;
  } else {
    d.innerHTML = `
      <div class="c-name">${card.name}</div>
      <div class="c-art">${art}</div>
      <div class="c-kind">${kind.toUpperCase()}</div>
      <div class="c-text">${card.text || ""}</div>`;
  }
  return d;
}

function monsterEl(m, owner, i, mine) {
  const atk = E.effectiveAtk(duel, owner, m);
  const d = el("div", `monster ${m.position}`);
  d.style.setProperty("--hue", hueFor(m.card));
  const art = m.card.img
    ? `<img class="m-img" src="${m.card.img}" alt="${m.card.name}" draggable="false">`
    : `<span class="c-glyph">${monogram(m.card.name)}</span>`;
  const equips = (m.equipped || []).map(c =>
    c.img
      ? `<img class="eq" src="${c.img}" title="${c.name} — ${c.text || ""}" alt="${c.name}" draggable="false">`
      : `<span class="eq eq-chip" title="${c.name} — ${c.text || ""}">${monogram(c.name)}</span>`
  ).join("");
  d.innerHTML = `
    <div class="m-name">${m.card.name}</div>
    <div class="m-art">${art}</div>
    <div class="m-stats"><span class="atk ${m.position === "attack" ? "active" : "dim"}">${atk}</span> / <span class="def ${m.position === "defense" ? "active" : "dim"}">${m.card.defense}</span></div>
    ${equips ? `<div class="equips">${equips}</div>` : ""}
    <div class="m-pos">${m.position === "attack" ? "ATK" : "DEF"}</div>`;
  if (atk !== m.card.atk) d.querySelector(".atk").classList.add("buff");

  if (mine && tributePick) {
    d.classList.add("selectable");
    if (tributePick.picks.has(i)) d.classList.add("picked");
    d.onclick = () => onTributeClick(i);
  } else if (mine) {
    d.classList.add("selectable");
    if (selField === i || attackFrom === i) d.classList.add("selected");
    if (spellPick) d.classList.add("targetable");
    d.onclick = () => onMyMonsterClick(i);
  } else {
    if (attackFrom >= 0 && phase === "battle" && !busy) {
      d.classList.add("targetable");
      d.onclick = () => onOppMonsterClick(i);
    }
    // hover 2s → info tooltip
    d.addEventListener("mouseenter", () => startTipTimer(d, m, owner));
    d.addEventListener("mouseleave", hideTip);
  }
  return d;
}

// ---------------------------------------------------------------- rendering

function renderBars(v, opp) {
  $("#opp-bar").innerHTML = `
    <span class="pname opp">${opp.name}</span>
    <span class="lp">${opp.lp} LP</span>
    <span>Hand ${opp.hand.length}</span>
    <span>Deck ${opp.deck.length}</span>
    <span>GY ${opp.graveyard.length}</span>`;
  $("#me-bar").innerHTML = `
    <span class="pname">${v.name}</span>
    <span class="lp">${v.lp} LP</span>
    <span>Deck ${v.deck.length}</span>
    <span>GY ${v.graveyard.length}</span>`;
  $("#mid-bar").innerHTML =
    `<span>Turn ${duel.turnNumber} — <b>${duel.current.name}</b></span>
     <span class="phase-chip">${PHASE_NAMES[phase]}</span>`;
}

function renderField(sel, owner, mine) {
  const zone = $(sel);
  zone.innerHTML = "";
  for (let i = 0; i < E.MAX_FIELD; i++) {
    const slot = el("div", "slot");
    if (owner.field[i]) slot.appendChild(monsterEl(owner.field[i], owner, i, mine));
    zone.appendChild(slot);
  }
}

function renderTraps(sel, p, mine) {
  const row = $(sel);
  row.innerHTML = "";
  p.traps.forEach(card => {
    const t = el("div", "trap-card" + (mine ? " mine" : ""));
    if (mine) t.title = `${card.name} — ${card.text || ""}`;
    row.appendChild(t);
  });
}

function renderHand(v, drewCount = 0) {
  const hand = $("#hand");
  hand.innerHTML = "";
  const interactive = !duel.current.isAI && !busy && phase !== "battle" && !tributePick && !spellPick;
  v.hand.forEach((card, i) => {
    const c = cardEl(card);
    if (i >= v.hand.length - drewCount) c.classList.add("draw-in");
    if (interactive) {
      c.classList.add("selectable");
      if (selHand === i) c.classList.add("selected");
      c.onclick = () => onHandClick(i);
    }
    hand.appendChild(c);
  });
}

// ---------------------------------------------------------------- popup prompts

function anchorForState(me) {
  if (tributePick || spellPick) return $("#my-field");
  if (attackFrom >= 0)
    return $("#my-field").children[attackFrom]?.firstElementChild;
  if (selHand >= 0 && phase !== "battle") return $("#hand").children[selHand];
  if (selField >= 0 && phase !== "battle")
    return $("#my-field").children[selField]?.firstElementChild;
  return null;
}

function positionPopup(pop, anchorRect) {
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = anchorRect.left + anchorRect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, innerWidth - pw - 8));
  let top = anchorRect.top - ph - 14;
  let below = false;
  if (top < 8) { top = anchorRect.bottom + 14; below = true; }
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  pop.classList.toggle("below", below);
}

function popupHeader(title) {
  const h = el("div", "p-head");
  h.appendChild(el("span", "p-title", title));
  const x = el("button", "p-close", "✕");
  x.onclick = clearSelection;
  h.appendChild(x);
  return h;
}

function popupButtons(...btns) {
  const row = el("div", "p-btns");
  row.append(...btns);
  return row;
}

function pbtn(label, cls, fn) {
  const b = el("button", "btn " + cls, label);
  b.onclick = fn;
  return b;
}

function renderPopup() {
  const pop = $("#popup");
  const me = duel.current;
  const humanTurn = !me.isAI && !busy && !duel.winner;
  const anchorEl = humanTurn ? anchorForState(me) : null;
  if (!anchorEl) { pop.classList.remove("show"); return; }

  pop.innerHTML = "";
  pop.appendChild(el("div", "arrow"));

  if (spellPick) {
    pop.appendChild(popupHeader(me.hand[spellPick.handIdx]?.name || "Spell"));
    pop.appendChild(el("div", "p-text", "Choose one of your monsters"));
    pop.appendChild(popupButtons(pbtn("Cancel", "", clearSelection)));
  } else if (tributePick) {
    pop.appendChild(popupHeader("Tribute Summon"));
    pop.appendChild(el("div", "p-text",
      `Choose <b>${tributePick.needed}</b> monster(s) to tribute — ${tributePick.picks.size}/${tributePick.needed} selected`));
    const ok = pbtn("Confirm", "primary", confirmTributes);
    ok.disabled = tributePick.picks.size !== tributePick.needed;
    pop.appendChild(popupButtons(ok, pbtn("Cancel", "", clearSelection)));
  } else if (attackFrom >= 0) {
    const m = me.field[attackFrom];
    if (!m) { pop.classList.remove("show"); return; }
    pop.appendChild(popupHeader(m.card.name));
    pop.appendChild(el("div", "p-text", "Choose an attack target"));
    const btns = [];
    if (!duel.other(me).field.length)
      btns.push(pbtn("Direct Attack!", "danger", doDirectAttack));
    btns.push(pbtn("Cancel", "", clearSelection));
    pop.appendChild(popupButtons(...btns));
  } else if (selHand >= 0 && phase !== "battle") {
    const card = me.hand[selHand];
    if (!card) { pop.classList.remove("show"); return; }
    pop.appendChild(popupHeader(card.name));
    const kind = card.kind || "monster";
    if (kind === "monster") {
      const [ok, reason] = E.canSummon(duel, me, card);
      pop.appendChild(el("div", "p-text",
        `ATK ${card.atk} / DEF ${card.defense} — Lv${card.level}` +
        (card.text ? `<br><span class="p-eff">${card.text}</span>` : "") +
        (ok ? "" : `<br><span class="p-reason">${reason}</span>`)));
      if (ok) {
        pop.appendChild(popupButtons(
          pbtn("Summon ATK", "primary", () => trySummon("attack")),
          pbtn("Summon DEF", "primary", () => trySummon("defense"))));
      }
    } else if (kind === "spell") {
      const opp = duel.other(me);
      const blocked =
        card.effect.type === "buff" && !me.field.length ? "You control no monsters." :
        card.effect.type === "destroy" && !opp.field.length ? "Opponent has no monsters." : null;
      pop.appendChild(el("div", "p-text",
        `SPELL — <span class="p-eff">${card.text}</span>` +
        (blocked ? `<br><span class="p-reason">${blocked}</span>` : "")));
      if (!blocked) pop.appendChild(popupButtons(pbtn("Play", "primary", tryPlaySpell)));
    } else {
      const full = me.traps.length >= E.MAX_TRAPS;
      pop.appendChild(el("div", "p-text",
        `TRAP — <span class="p-eff">${card.text}</span>` +
        (full ? `<br><span class="p-reason">Trap zone is full (3).</span>` :
                `<br>Set it face-down; it triggers on the opponent's attack.`)));
      if (!full) pop.appendChild(popupButtons(pbtn("Set trap", "primary", trySetTrap)));
    }
  } else if (selField >= 0 && phase !== "battle") {
    const m = me.field[selField];
    if (!m) { pop.classList.remove("show"); return; }
    pop.appendChild(popupHeader(m.card.name));
    const block =
      m.summonedThisTurn ? "Summoned this turn." :
      m.attackedThisTurn ? "Already attacked this turn." :
      m.positionChanged ? "Already changed position." : null;
    if (block) {
      pop.appendChild(el("div", "p-text p-reason", block));
    } else {
      pop.appendChild(el("div", "p-text",
        `${m.position === "attack" ? "ATK" : "DEF"} position`));
      pop.appendChild(popupButtons(pbtn("Switch position", "primary", () => {
        const [ok, reason] = E.switchPosition(duel, me, selField);
        if (!ok) notice(reason);
        selField = -1;
        render();
      })));
    }
  }

  pop.classList.add("show");
  positionPopup(pop, anchorEl.getBoundingClientRect());
}

function clearSelection() {
  if (selHand < 0 && selField < 0 && attackFrom < 0 && !tributePick && !spellPick) return;
  selHand = selField = attackFrom = -1;
  tributePick = spellPick = null;
  render();
}

// ---------------------------------------------------------------- hover tooltip

let tipTimer = null;

function startTipTimer(anchor, m, owner) {
  hideTip();
  tipTimer = setTimeout(() => showTip(anchor, m, owner), 2000);
}

function showTip(anchor, m, owner) {
  const tip = $("#cardtip");
  const atk = E.effectiveAtk(duel, owner, m);
  const buff = atk !== m.card.atk ? ` <span class="p-eff">(base ${m.card.atk})</span>` : "";
  tip.innerHTML = `
    <div class="arrow"></div>
    <div class="p-head"><span class="p-title">${m.card.name}</span></div>
    <div class="p-text">
      ${"★".repeat(m.card.level)}${m.card.type ? " · " + m.card.type : ""} · ${m.position === "attack" ? "ATK" : "DEF"} position<br>
      ATK ${atk}${buff} / DEF ${m.card.defense}
      ${m.card.text ? `<br><span class="p-eff">${m.card.text}</span>` : ""}
      ${(m.equipped || []).length ? `<br><span class="p-eff">Equipped: ${m.equipped.map(c => c.name).join(", ")}</span>` : ""}
    </div>`;
  tip.classList.add("show");
  positionPopup(tip, anchor.getBoundingClientRect());
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  $("#cardtip").classList.remove("show");
}

function renderSide() {
  const me = duel.current;
  const humanTurn = !me.isAI && !busy && !duel.winner;

  // turn indicator circles — fixed seat order, active player lit
  const ind = $("#turn-ind");
  ind.innerHTML = "";
  duel.players.forEach(p => {
    const d = el("div", "ind" + (p === duel.current && !duel.winner ? " active" : ""));
    d.innerHTML = `<span class="dot">${p.name[0].toUpperCase()}</span>` +
                  `<span class="ind-name">${p.name}</span>`;
    ind.appendChild(d);
  });

  const tc = $("#turn-controls");
  tc.innerHTML = "";
  const midAction = tributePick !== null || spellPick !== null || attackFrom >= 0;
  if (phase === "main") {
    const b = el("button", "btn phase", "Battle Phase ▸");
    b.disabled = !humanTurn || midAction;
    b.onclick = () => { phase = "battle"; selHand = selField = -1; render(); };
    tc.appendChild(b);
  } else if (phase === "battle") {
    const b = el("button", "btn phase", "Main Phase 2 ▸");
    b.disabled = !humanTurn || midAction;
    b.onclick = () => { phase = "main2"; attackFrom = -1; render(); };
    tc.appendChild(b);
  }
  const end = el("button", "btn end", "End Turn");
  end.disabled = !humanTurn;
  end.onclick = () => { if (endTurnResolve) endTurnResolve(); };
  tc.appendChild(end);

  const conc = el("button", "btn concede", "Concede");
  conc.disabled = duel.winner;
  conc.onclick = () => {
    if (duel.winner) return;
    duel.winner = duel.other(viewer());
    duel.loserReason = `${viewer().name} conceded.`;
    render();
  };
  tc.appendChild(conc);
}

function renderLog() {
  const box = $("#log");
  box.innerHTML = duel.logs.slice(-80).map(l => `<div>${l}</div>`).join("");
  box.scrollTop = box.scrollHeight;
}

function render() {
  if (!duel) return;
  hideTip();
  const v = viewer();
  const opp = duel.other(v);
  const drewForV = duel.events
    .filter(e => e.t === "draw" && e.owner === v)
    .reduce((s, e) => s + e.n, 0);
  renderBars(v, opp);
  renderField("#opp-field", opp, false);
  renderField("#my-field", v, true);
  renderTraps("#opp-traps", opp, false);
  renderTraps("#my-traps", v, true);
  renderHand(v, drewForV);
  renderSide();
  renderLog();
  renderPopup();
  drainEvents();
  lpDiff(v, opp);
  if (duel.winner && !gameOverShown) {
    gameOverShown = true;
    setTimeout(showGameOver, 700);
  }
}

// ---------------------------------------------------------------- input handlers

function onHandClick(i) {
  sfx.click();
  selHand = selHand === i ? -1 : i;
  selField = -1;
  render();
}

function tryPlaySpell() {
  const me = duel.current;
  const card = me.hand[selHand];
  if (!card || card.kind !== "spell") return;
  if (card.effect.type === "buff") {
    spellPick = { handIdx: selHand };
    selHand = -1;
    render();
    return;
  }
  const [ok, reason] = E.playSpell(duel, me, selHand, null);
  if (!ok) notice(reason);
  selHand = -1;
  render();
}

function trySetTrap() {
  const me = duel.current;
  const [ok, reason] = E.setTrap(duel, me, selHand);
  if (!ok) notice(reason);
  selHand = -1;
  render();
}

function onMyMonsterClick(i) {
  if (duel.current.isAI || busy || duel.winner) return;
  const me = duel.current;
  const m = me.field[i];
  if (spellPick) {
    const [ok, reason] = E.playSpell(duel, me, spellPick.handIdx, i);
    if (!ok) notice(reason);
    spellPick = null;
    render();
    return;
  }
  if (phase === "battle") {
    if (m.position !== "attack") return notice(`${m.card.name} is in defense position.`);
    if (m.attacksLeft <= 0) return notice(`${m.card.name} has already attacked.`);
    sfx.click();
    attackFrom = attackFrom === i ? -1 : i;
    selField = -1;
  } else {
    sfx.click();
    selField = selField === i ? -1 : i;
    attackFrom = -1;
  }
  render();
}

function onOppMonsterClick(j) {
  const [ok, reason] = E.attack(duel, duel.current, attackFrom, j);
  if (!ok) notice(reason);
  attackFrom = -1;
  render();
}

function onTributeClick(i) {
  if (tributePick.picks.has(i)) tributePick.picks.delete(i);
  else if (tributePick.picks.size < tributePick.needed) tributePick.picks.add(i);
  render();
}

function trySummon(position) {
  const me = duel.current;
  const card = me.hand[selHand];
  const [ok, reason] = E.canSummon(duel, me, card);
  if (!ok) return notice(reason);
  const needed = E.tributesNeeded(card);
  if (needed === 0) {
    E.summon(duel, me, selHand, position, []);
    selHand = -1;
  } else {
    tributePick = { handIdx: selHand, position, needed, picks: new Set() };
    selHand = -1;
  }
  render();
}

function confirmTributes() {
  const me = duel.current;
  if (tributePick.picks.size !== tributePick.needed) return;
  E.summon(duel, me, tributePick.handIdx, tributePick.position, [...tributePick.picks]);
  tributePick = null;
  render();
}

function doDirectAttack() {
  const [ok, reason] = E.attack(duel, duel.current, attackFrom, null);
  if (!ok) notice(reason);
  attackFrom = -1;
  render();
}

// ---------------------------------------------------------------- overlays

function pickDiscard(me) {
  return new Promise(res => {
    const p = overlay(`<h2>Hand limit ${E.HAND_LIMIT}</h2>
      <p>Choose a card to discard:</p><div class="pick-row"></div>`);
    const row = p.querySelector(".pick-row");
    me.hand.forEach((card, i) => {
      const c = cardEl(card);
      c.classList.add("selectable");
      c.onclick = () => { hideOverlay(); res(i); };
      row.appendChild(c);
    });
  });
}

function showGameOver() {
  const w = duel.winner, l = duel.other(w);
  if (w === viewer()) sfx.win(); else sfx.lose();
  const p = overlay(`<h1 class="win">${w.name} WINS!</h1>
    <p>${duel.loserReason}</p>
    <p>Final LP — ${w.name}: ${w.lp} | ${l.name}: ${l.lp}</p>
    <button class="btn primary">Play again</button>`);
  p.querySelector("button").onclick = () => location.reload();
}

// ---------------------------------------------------------------- start screen

function showStartScreen() {
  const deckOpts = Object.entries(deckLists)
    .map(([n, ids]) => `<option value="${n}">${n} (${ids.length} cards)</option>`).join("");
  const p = overlay(`
    <h1 class="title">DUEL</h1>
    <p class="sub">a tiny Yu-Gi-Oh-style card game — 4000 LP, first to 0 loses</p>
    <div class="form">
      <label>Your name <input id="n1" placeholder="Player 1"></label>
      <label>Deck <select id="d1">${deckOpts}</select></label>
    </div>
    <button class="btn primary big" id="start">Start Duel</button>`);
  p.querySelector("#start").onclick = () => {
    const n1 = p.querySelector("#n1").value.trim() || "Player 1";
    const d1 = p.querySelector("#d1").value;
    hideOverlay();
    beginGame(n1, d1);
  };
}

// ---------------------------------------------------------------- game flow

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeck(ids) {
  return shuffle(ids.map(id => db[id]));
}

async function beginGame(n1, d1) {
  const deckKeys = Object.keys(deckLists);
  const aiDeck = deckKeys[Math.floor(Math.random() * deckKeys.length)];
  const players = [E.makePlayer(n1, buildDeck(deckLists[d1])),
                   E.makePlayer("CPU", buildDeck(deckLists[aiDeck]), true)];
  shuffle(players); // coin flip for who goes first
  duel = new E.Duel(players[0], players[1]);
  for (const p of players) E.drawCards(duel, p, E.STARTING_HAND);
  E.log(duel, `${players[0].name} goes first (skips first draw).`);
  gameOverShown = false;
  busy = true;
  render();
  const panel = overlay(`<h2>${players[0].name} goes first!</h2>
    <p>(first player skips their first draw)</p>
    <button class="btn primary">Begin</button>`);
  panel.querySelector("button").onclick = () => { hideOverlay(); busy = false; runLoop(); };
}

async function waitForEndTurn() {
  return new Promise(res => { endTurnResolve = () => { endTurnResolve = null; res(); }; });
}

async function runLoop() {
  while (!duel.winner) {
    const me = duel.current;
    phase = "main";
    selHand = selField = attackFrom = -1;
    tributePick = null;
    E.log(duel, `— Turn ${duel.turnNumber}: ${me.name} —`);
    toast(`${me.name}'s turn`);
    sfx.turn();
    E.startTurn(duel);
    render();
    if (duel.winner) break;
    if (me.isAI) {
      busy = true;
      render();
      await AI.takeTurn(duel, me, render);
      busy = false;
    } else {
      render();
      await waitForEndTurn();
    }
    if (duel.winner) break;
    while (me.hand.length > E.HAND_LIMIT) {
      const idx = me.isAI ? E.weakestHandIndex(me) : await pickDiscard(me);
      E.discard(duel, me, idx);
    }
    E.endTurn(duel);
    render();
  }
  render();
}

// ---------------------------------------------------------------- boot

async function boot() {
  const data = await (await fetch("cards.json")).json();
  for (const c of data.cards) db[c.id] = c;
  deckLists = data.decks;

  const snd = $("#snd");
  const upd = () => snd.textContent = `Sound: ${soundEnabled() ? "on" : "off"}`;
  snd.onclick = () => { setSoundEnabled(!soundEnabled()); upd(); sfx.click(); };
  upd();

  // subtle click for any sidebar button
  $("#side").addEventListener("click", e => {
    if (e.target.closest(".btn") && !e.target.closest("#snd")) sfx.click();
  });

  // dismiss popup on outside click / Escape
  document.addEventListener("click", e => {
    if (e.target.closest("#popup, .selectable, .targetable, .slot, .btn, #side, #hand"))
      return;
    clearSelection();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") clearSelection();
  });

  showStartScreen();
}

boot();

// audio.js — tiny synthesized SFX via Web Audio API. No assets needed.

let ctx = null;
let enabled = localStorage.getItem("duel-sound") !== "off";

export function soundEnabled() { return enabled; }
export function setSoundEnabled(v) {
  enabled = v;
  localStorage.setItem("duel-sound", v ? "on" : "off");
}

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function env(g, t, attack, peak, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
}

// pitched blip — f: start freq, f2: end freq (glide), t: delay, dur: seconds
function tone({ f = 440, f2 = null, t = 0, dur = 0.15, type = "sine", vol = 0.2 }) {
  if (!enabled) return;
  try {
    const c = ac(), o = c.createOscillator(), g = c.createGain();
    const start = c.currentTime + t;
    o.type = type;
    o.frequency.setValueAtTime(f, start);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(f2, 1), start + dur);
    env(g, start, 0.008, vol, dur);
    o.connect(g).connect(c.destination);
    o.start(start);
    o.stop(start + dur + 0.05);
  } catch { /* audio unavailable */ }
}

// filtered noise burst — whooshes, explosions, card flicks
function noise({ t = 0, dur = 0.2, vol = 0.3, f = 1200, f2 = null, q = 1, type = "lowpass" }) {
  if (!enabled) return;
  try {
    const c = ac();
    const start = c.currentTime + t;
    const len = Math.max(1, Math.ceil(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const flt = c.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(f, start);
    if (f2) flt.frequency.exponentialRampToValueAtTime(Math.max(f2, 10), start + dur);
    flt.Q.value = q;
    const g = c.createGain();
    env(g, start, 0.005, vol, dur);
    src.connect(flt).connect(g).connect(c.destination);
    src.start(start);
    src.stop(start + dur + 0.05);
  } catch { /* audio unavailable */ }
}

export const sfx = {
  click() {
    tone({ f: 880, dur: 0.045, type: "square", vol: 0.05 });
  },
  draw() {
    noise({ dur: 0.06, vol: 0.12, f: 4500, q: 2, type: "bandpass" });
    tone({ f: 1400, dur: 0.03, type: "sine", vol: 0.05 });
  },
  summon() {
    tone({ f: 120, f2: 55, dur: 0.22, type: "sine", vol: 0.3 });
    tone({ f: 220, dur: 0.12, type: "triangle", vol: 0.14 });
    noise({ dur: 0.14, vol: 0.14, f: 700 });
  },
  switch() {
    noise({ dur: 0.13, vol: 0.14, f: 2600, f2: 500 });
  },
  attack() {
    noise({ dur: 0.2, vol: 0.3, f: 3200, f2: 300 });
    tone({ f: 320, f2: 80, dur: 0.18, type: "sawtooth", vol: 0.1 });
  },
  destroy() {
    noise({ dur: 0.42, vol: 0.4, f: 900, f2: 70 });
    tone({ f: 140, f2: 38, dur: 0.4, type: "square", vol: 0.12 });
    tone({ f: 58, dur: 0.32, type: "sine", vol: 0.25 });
  },
  hit() {
    tone({ f: 170, f2: 70, dur: 0.15, type: "triangle", vol: 0.28 });
    noise({ dur: 0.09, vol: 0.18, f: 1100 });
  },
  heal() {
    tone({ f: 520, dur: 0.12, type: "sine", vol: 0.14 });
    tone({ f: 780, t: 0.1, dur: 0.18, type: "sine", vol: 0.14 });
  },
  effect() {
    tone({ f: 660, dur: 0.06, type: "sine", vol: 0.12 });
    tone({ f: 880, t: 0.05, dur: 0.06, type: "sine", vol: 0.12 });
    tone({ f: 1320, t: 0.1, dur: 0.1, type: "sine", vol: 0.12 });
  },
  turn() {
    tone({ f: 440, dur: 0.09, type: "triangle", vol: 0.12 });
    tone({ f: 660, t: 0.08, dur: 0.13, type: "triangle", vol: 0.12 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) =>
      tone({ f, t: i * 0.12, dur: 0.22, type: "triangle", vol: 0.16 }));
  },
  lose() {
    [400, 300, 220, 140].forEach((f, i) =>
      tone({ f, t: i * 0.14, dur: 0.22, type: "sawtooth", vol: 0.09 }));
  },
};

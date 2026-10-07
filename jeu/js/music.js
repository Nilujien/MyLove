// Musique de fond originale, générée en direct (Web Audio) :
// ambiance de voyage épique et mystique — flûte façon shakuhachi, nappes de cordes,
// ostinato de violoncelle, taikos et éclats de célesta, en ré mineur pentatonique.

const BPM = 72;
const BEAT = 60 / BPM;
const STEP = BEAT / 4; // double-croche
const PREF_KEY = 'iso-jeu-musique';

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// Progression (une mesure par accord), en notes MIDI.
const PROG = [
  [50, 57, 62, 65], // Rém
  [46, 53, 58, 62], // Si♭
  [48, 55, 60, 64], // Do
  [45, 52, 57, 60], // Lam
  [50, 57, 62, 65], // Rém
  [41, 53, 57, 60], // Fa
  [43, 55, 58, 62], // Solm
  [45, 52, 57, 61], // La (dominante)
];
// Ré mineur pentatonique (ré, fa, sol, la, do) sur deux octaves.
const SCALE = [62, 65, 67, 69, 72, 74, 77, 79, 81, 84];

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mélodie : motifs de deux mesures répétés avec variations, en croches et noires.
function composeMelody(seed) {
  const rand = mulberry32(seed);
  const phrases = [];
  for (let p = 0; p < 4; p++) {
    const motif = [];
    let idx = 2 + Math.floor(rand() * 3);
    let pos = 0;
    while (pos < 32) { // 2 mesures de 16 doubles-croches
      const len = [2, 2, 4, 4, 6, 8][Math.floor(rand() * 6)];
      idx = Math.max(0, Math.min(SCALE.length - 1, idx + [-2, -1, -1, 0, 1, 1, 2][Math.floor(rand() * 7)]));
      const rest = rand() < 0.12 && pos > 0;
      motif.push({ pos, len: Math.min(len, 32 - pos), note: rest ? null : SCALE[idx] });
      pos += len;
    }
    // Réponse : même rythme, notes décalées, fin sur une note longue.
    const answer = motif.map((n, i) => ({
      ...n,
      pos: n.pos + 32,
      note: n.note === null ? null : SCALE[Math.max(0, Math.min(SCALE.length - 1, SCALE.indexOf(n.note) + (i % 3 === 0 ? -1 : 1)))],
    }));
    const last = answer[answer.length - 1];
    if (last) last.note = SCALE[rand() < 0.5 ? 0 : 3];
    phrases.push([...motif, ...answer]); // 4 mesures
  }
  return phrases;
}

function makeImpulse(ctx, seconds = 3.2, decay = 2.6) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
  }
  return buf;
}

// Moteur musical : planifie les notes à l'avance sur l'horloge audio.
export function createEngine(ctx, destination = ctx.destination) {
  const master = ctx.createGain();
  master.gain.value = 0;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.ratio.value = 3;
  master.connect(comp).connect(destination);

  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx);
  const wet = ctx.createGain(); wet.gain.value = 0.55;
  reverb.connect(wet).connect(master);
  const bus = (dry, send) => {
    const g = ctx.createGain(); g.gain.value = dry;
    const s = ctx.createGain(); s.gain.value = send;
    g.connect(master); g.connect(s).connect(reverb);
    return g;
  };
  const padBus = bus(0.22, 0.9);
  const fluteBus = bus(0.32, 0.7);
  const celloBus = bus(0.3, 0.35);
  const drumBus = bus(0.55, 0.3);
  const bellBus = bus(0.12, 0.9);

  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }

  const env = (g, t, a, peak, hold, r) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + r);
    return t + a + hold + r + 0.05;
  };

  // Nappe de cordes : dents de scie désaccordées, filtrées.
  function pad(t, notes, dur, level) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 900 + level * 900; filter.Q.value = 0.5;
    const g = ctx.createGain();
    filter.connect(g).connect(padBus);
    const end = env(g, t, 1.4, 0.16 * level, Math.max(0, dur - 1.4), 1.8);
    for (const m of notes) {
      for (const detune of [-8, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = midiHz(m); o.detune.value = detune;
        o.connect(filter); o.start(t); o.stop(end);
      }
    }
  }

  // Flûte façon shakuhachi : glissé vers la note, souffle, vibrato tardif.
  let lastFlute = null;
  function flute(t, m, dur, octave) {
    const f = midiHz(m + octave);
    const o = ctx.createOscillator(); o.type = 'sine';
    const o2 = ctx.createOscillator(); o2.type = 'triangle';
    const g = ctx.createGain(), g2 = ctx.createGain(); g2.gain.value = 0.18;
    const from = lastFlute && Math.abs(lastFlute - f) / f < 0.6 ? lastFlute : f * 0.97;
    for (const osc of [o, o2]) {
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(f, t + 0.09);
    }
    lastFlute = f;
    const vib = ctx.createOscillator(); vib.frequency.value = 5.2;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t); vibG.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(dur, 0.6));
    vib.connect(vibG); vibG.connect(o.frequency); vibG.connect(o2.frequency);
    o.connect(g); o2.connect(g2).connect(g); g.connect(fluteBus);
    const end = env(g, t, 0.07, 0.22, Math.max(0, dur - 0.12), 0.35);
    // Souffle au début de la note.
    const n = ctx.createBufferSource(); n.buffer = noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 2;
    const ng = ctx.createGain(); n.connect(bp).connect(ng).connect(fluteBus);
    env(ng, t, 0.02, 0.05, 0.03, 0.15);
    for (const osc of [o, o2, vib]) { osc.start(t); osc.stop(end); }
    n.start(t, Math.random() * 0.5); n.stop(t + 0.3);
  }

  // Violoncelle en ostinato : notes brèves et rondes.
  function cello(t, m, accent) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midiHz(m);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 1.2;
    const g = ctx.createGain();
    o.connect(lp).connect(g).connect(celloBus);
    const end = env(g, t, 0.02, accent ? 0.3 : 0.2, 0.08, 0.32);
    o.start(t); o.stop(end);
  }

  // Taiko : sinus à hauteur plongeante + claquement de peau.
  function taiko(t, vel) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.3);
    const g = ctx.createGain(); o.connect(g).connect(drumBus);
    const end = env(g, t, 0.004, 0.9 * vel, 0.02, 0.7);
    o.start(t); o.stop(end);
    const n = ctx.createBufferSource(); n.buffer = noise;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
    const ng = ctx.createGain(); n.connect(lp).connect(ng).connect(drumBus);
    env(ng, t, 0.002, 0.35 * vel, 0.01, 0.12);
    n.start(t, Math.random() * 0.5); n.stop(t + 0.2);
  }

  // Célesta : sinus aigus à décroissance lente.
  function bell(t, m) {
    for (const [mul, lvl] of [[1, 0.12], [4.01, 0.03]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = midiHz(m + 12) * mul;
      const g = ctx.createGain(); o.connect(g).connect(bellBus);
      const end = env(g, t, 0.005, lvl, 0, 2.2);
      o.start(t); o.stop(end);
    }
  }

  const rand = mulberry32(20261007);
  let phrases = composeMelody(7);
  let step = 0;
  let nextTime = 0;
  let cycle = 0;

  // Structure en 32 mesures : calme, voyage, voyage (plus intense), retour au calme.
  function sectionOf(bar) {
    const s = Math.floor((bar % 32) / 8);
    return ['calm', 'journey', 'peak', 'calm'][s];
  }

  function scheduleStep(s, t) {
    const bar = Math.floor(s / 16), pos = s % 16;
    const section = sectionOf(bar);
    const chord = PROG[bar % PROG.length];
    const level = section === 'calm' ? 0.75 : section === 'journey' ? 1 : 1.15;
    if (pos === 0) {
      pad(t, chord, BEAT * 4, level);
      if (bar % 32 === 0 && bar > 0) { cycle++; phrases = composeMelody(7 + cycle); }
    }
    // Ostinato de violoncelle (croches) pendant le voyage.
    if (section !== 'calm' && pos % 2 === 0) {
      const pattern = [0, 7, 12, 7, 0, 7, 10, 7];
      cello(t, chord[0] - 12 + pattern[(pos / 2) % 8], pos % 8 === 0);
    }
    // Taikos : marche ample, roulement en fin de phrase.
    if (section !== 'calm') {
      const hits = { 0: 1, 6: 0.55, 8: 0.85, 11: 0.4, 12: 0.7 };
      if (hits[pos] !== undefined) taiko(t, hits[pos] * (section === 'peak' ? 1 : 0.8));
      if (bar % 4 === 3 && pos >= 12) taiko(t, 0.35 + (pos - 12) * 0.12);
    } else if (pos === 0 && bar % 2 === 0) {
      taiko(t, 0.35); // pulsation lointaine
    }
    // Flûte : phrase de 4 mesures, une octave plus haut au sommet.
    const phrase = phrases[Math.floor(bar / 4) % phrases.length];
    const local = (bar % 4) * 16 + pos;
    if (bar % 8 < 4 || section !== 'calm') {
      for (const n of phrase) {
        if (n.pos === local && n.note !== null) flute(t, n.note, n.len * STEP * 0.95, section === 'peak' ? 12 : 0);
      }
    }
    // Éclats de célesta, plus présents dans le calme.
    if (pos % 4 === 2 && rand() < (section === 'calm' ? 0.35 : 0.12)) bell(t, SCALE[Math.floor(rand() * SCALE.length)]);
  }

  return {
    // Planifie toutes les notes jusqu'au temps audio « until ».
    scheduleUntil(until) {
      if (!nextTime) nextTime = ctx.currentTime + 0.1;
      while (nextTime < until) {
        scheduleStep(step, nextTime);
        step++;
        nextTime += STEP;
      }
    },
    fadeTo(v, seconds = 1.5) {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(v, t + seconds);
    },
    resetClock() { nextTime = 0; },
  };
}

// ---------- Lecture dans le jeu : bouton 🎵 et touche M ----------
const VOLUME = 0.55;
let ctx = null, engine = null, timer = 0, playing = false;

function loadPref() {
  try { return localStorage.getItem(PREF_KEY) !== '0'; } catch { return true; }
}
function savePref(on) {
  try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch { /* stockage indisponible */ }
}

function start() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    engine = createEngine(ctx);
  }
  ctx.resume();
  engine.resetClock();
  clearInterval(timer);
  timer = setInterval(() => engine.scheduleUntil(ctx.currentTime + 0.4), 100);
  engine.scheduleUntil(ctx.currentTime + 0.4);
  engine.fadeTo(VOLUME, 2.5);
  playing = true;
  updateButton();
}

function stop() {
  if (!ctx) return;
  playing = false;
  engine.fadeTo(0, 1.2);
  clearInterval(timer);
  setTimeout(() => { if (!playing) ctx.suspend(); }, 1400);
  updateButton();
}

function toggle() {
  const on = !playing;
  savePref(on);
  on ? start() : stop();
}

const button = document.getElementById('music-toggle');
function updateButton() {
  if (!button) return;
  button.classList.toggle('active', playing);
  button.textContent = playing ? '🎵 Musique' : '🔇 Musique';
}

if (button) {
  updateButton();
  button.addEventListener('click', () => { button.blur(); toggle(); });
  // Les navigateurs exigent un geste de l'utilisateur avant de jouer du son.
  const firstGesture = (e) => {
    window.removeEventListener('pointerdown', firstGesture, true);
    window.removeEventListener('keydown', firstGesture, true);
    if (e.target === button) return; // le bouton gère lui-même son clic
    if (e.code === 'KeyM') return; // la touche M gère elle-même la bascule
    if (loadPref() && !playing) start();
  };
  window.addEventListener('pointerdown', firstGesture, true);
  window.addEventListener('keydown', firstGesture, true);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement)) toggle();
  });
  // Coupe le son quand l'onglet est caché, le reprend au retour.
  document.addEventListener('visibilitychange', () => {
    if (!ctx || !playing) return;
    if (document.hidden) ctx.suspend(); else ctx.resume();
  });
}

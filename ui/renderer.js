// Renderer for the full-screen ghost overlay. The main process owns the window. This draws the ghost and decides how it moves.
const api = window.paperclip;
const ghost = document.getElementById('ghost');
const bubble = document.getElementById('bubble');
const pupilLeft = document.getElementById('pupilLeft');
const pupilRight = document.getElementById('pupilRight');
const flash = document.getElementById('flash');
const candle = document.getElementById('candle');
const canvas = document.getElementById('splatter');
const context = canvas.getContext('2d');

const ghostWidth = 190;
const ghostHeight = 228;
const maxPupilOffset = 6;
const nearRadius = 180; // hover zone around the ghost centre
const fleeDistance = 200; // normal mode: ease away by about this much
const fleeEase = 0.06;
const followStep = 1.4; // possessed mode: slow pursuit, pixels per frame
const followStop = 90;
const splatterChance = 0.25;
const bubbleMs = 12_000;

let width = window.innerWidth;
let height = window.innerHeight;
canvas.width = width;
canvas.height = height;

let mode = { possessed: false, lightning: true };
let cursor = null; // screen coordinates, from the main process
let fakeCursor = null; // used by the flee demo for a moment
let fakeUntil = 0;
let pos = { x: width - ghostWidth - 24, y: height - ghostHeight - 24 }; // top-left of the ghost
let target = { ...pos };
let near = false;
let busy = false; // splattering or reforming
let dragging = null;
let particles = [];
let trail = []; // ink trail dots, left behind by the ink effect
let tween = null; // a timed glide, used by peek and ink
let hoverOver = false;
let flashedThisSession = false;
let hideTimer = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function centre() {
  return { x: pos.x + ghostWidth / 2, y: pos.y + ghostHeight / 2 };
}

function clampToScreen(point) {
  return { x: clamp(point.x, 0, width - ghostWidth), y: clamp(point.y, 0, height - ghostHeight) };
}

// The cursor the ghost reacts to. The flee demo can stand in for it briefly.
function activeCursor() {
  if (fakeCursor && performance.now() < fakeUntil) return fakeCursor;
  fakeCursor = null;
  return cursor;
}

function inside(rect, point) {
  return point && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

// Clicks pass through everywhere except over the ghost and the bubble.
function updateHover() {
  const over = inside(ghost.getBoundingClientRect(), cursor)
    || (bubble.classList.contains('shown') && inside(bubble.getBoundingClientRect(), cursor));
  if (over !== hoverOver) {
    hoverOver = over;
    api.setHover(over);
  }
}

// Normal mode: pupils follow the cursor. Possessed mode: pupils stare straight ahead, and one drifts (CSS).
function updatePupils() {
  if (cursor && !mode.possessed) {
    const c = centre();
    const dx = clamp((cursor.x - c.x) / 300, -1, 1);
    const dy = clamp((cursor.y - c.y) / 300, -1, 1);
    setPupils(dx * maxPupilOffset, dy * maxPupilOffset);
  } else {
    setPupils(0, 0);
  }
}

function setPupils(offsetX, offsetY) {
  pupilLeft.setAttribute('cx', 82 + offsetX);
  pupilLeft.setAttribute('cy', 112 + offsetY);
  pupilRight.setAttribute('cx', 118 + offsetX);
  pupilRight.setAttribute('cy', 112 + offsetY);
}

// Normal mode flees the cursor. Possessed mode follows it slowly.
function stepBehaviour() {
  if (busy || dragging) return;
  const point = activeCursor();
  if (!point) return;
  const c = centre();
  const dx = c.x - point.x;
  const dy = c.y - point.y;
  const dist = Math.hypot(dx, dy) || 1;

  if (dist >= nearRadius) {
    near = false;
    return;
  }
  if (!near) {
    near = true;
    const demo = point === fakeCursor;
    if (!demo && Math.random() < splatterChance) {
      splatter();
      return;
    }
  }

  if (mode.possessed) {
    if (dist > followStop) {
      pos = clampToScreen({
        x: pos.x + ((point.x - c.x) / dist) * followStep,
        y: pos.y + ((point.y - c.y) / dist) * followStep,
      });
    }
  } else {
    target = clampToScreen({
      x: c.x + (dx / dist) * fleeDistance - ghostWidth / 2,
      y: c.y + (dy / dist) * fleeDistance - ghostHeight / 2,
    });
  }
}

function easeTowardTarget() {
  if (busy || dragging || mode.possessed) return;
  pos = {
    x: pos.x + (target.x - pos.x) * fleeEase,
    y: pos.y + (target.y - pos.y) * fleeEase,
  };
}

// Red ink splatter: the ghost bursts, then reforms at least 350px from the cursor.
function splatter() {
  busy = true;
  ghost.classList.add('hidden');
  const c = centre();
  particles = Array.from({ length: 56 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 9;
    return {
      x: c.x,
      y: c.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      life: 1,
      size: 3 + Math.random() * 7,
    };
  });
  setTimeout(reform, 1300);
}

function reform() {
  const point = activeCursor() ?? { x: width / 2, y: height / 2 };
  let spot = clampToScreen({ x: Math.random() * width, y: Math.random() * height });
  for (let tries = 0; tries < 40; tries += 1) {
    spot = clampToScreen({ x: Math.random() * width, y: Math.random() * height });
    if (Math.hypot(spot.x + ghostWidth / 2 - point.x, spot.y + ghostHeight / 2 - point.y) >= 350) break;
  }
  pos = spot;
  target = { ...spot };
  near = false;
  busy = false;
  ghost.classList.remove('hidden');
}

function drawParticles() {
  context.clearRect(0, 0, width, height);
  trail = trail.filter((dot) => dot.life > 0);
  context.fillStyle = '#8E1B14';
  for (const dot of trail) {
    dot.life -= 0.012;
    context.globalAlpha = Math.max(0, dot.life) * 0.7;
    context.beginPath();
    context.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2);
    context.fill();
  }
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.97;
    p.vy = p.vy * 0.97 + 0.3;
    p.life -= 0.02;
    context.globalAlpha = Math.max(0, p.life);
    context.beginPath();
    context.arc(p.x, p.y, p.size * (0.6 + p.life * 0.4), 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
}

// Glide the ghost to a point over a set time. keepBusy holds the ghost still after the glide, for a later step.
function glide(to, duration, options = {}) {
  busy = true;
  tween = {
    from: { ...pos },
    to,
    start: performance.now(),
    duration,
    keepBusy: options.keepBusy ?? false,
    leaveTrail: options.leaveTrail ?? false,
    onDone: options.onDone,
  };
}

function stepTween(now) {
  if (!tween) return;
  const t = Math.min(1, (now - tween.start) / tween.duration);
  const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in and out
  pos = {
    x: tween.from.x + (tween.to.x - tween.from.x) * eased,
    y: tween.from.y + (tween.to.y - tween.from.y) * eased,
  };
  if (tween.leaveTrail) {
    const c = centre();
    trail.push({ x: c.x, y: c.y, life: 1, size: 3 + Math.random() * 3 });
  }
  if (t >= 1) {
    const done = tween;
    tween = null;
    if (!done.keepBusy) busy = false;
    done.onDone?.();
  }
}

// Peek: the ghost slides in from the nearest edge, hangs there, then slides back.
function peek() {
  const home = { ...pos };
  const out = pos.x + ghostWidth / 2 < width / 2
    ? { x: -ghostWidth * 0.7, y: home.y }
    : { x: width - ghostWidth * 0.3, y: home.y };
  glide(out, 700, {
    keepBusy: true,
    onDone: () => setTimeout(() => glide(home, 700), 1200),
  });
}

// Shiver: a quick jitter for about a second.
function shiver() {
  ghost.classList.add('shiver');
  setTimeout(() => ghost.classList.remove('shiver'), 900);
}

// Candle: one warm flicker along the bottom of the screen.
function candleFlicker() {
  candle.classList.remove('on');
  void candle.offsetWidth;
  candle.classList.add('on');
}

// Ink: the ghost glides across the screen and leaves a red trail.
function ink() {
  const c = centre();
  const to = clampToScreen({
    x: c.x < width / 2 ? width - ghostWidth - 40 : 40,
    y: 60 + Math.random() * Math.max(0, height - ghostHeight - 120),
  });
  glide(to, 1800, { leaveTrail: true });
}

// One soft flash, then thunder synthesized with Web Audio. No audio files.
function lightning() {
  flash.classList.remove('on');
  void flash.offsetWidth;
  flash.classList.add('on');
  setTimeout(thunder, 350);
}

function thunder() {
  const audio = new AudioContext();
  const now = audio.currentTime;
  const duration = 3.2;

  const buffer = audio.createBuffer(1, Math.floor(audio.sampleRate * duration), audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  }
  const noise = audio.createBufferSource();
  noise.buffer = buffer;
  const lowpass = audio.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 160;
  const noiseGain = audio.createGain();
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.9, now + 0.25);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  noise.connect(lowpass).connect(noiseGain).connect(audio.destination);
  noise.start(now);

  const rumble = audio.createOscillator();
  rumble.type = 'sine';
  rumble.frequency.value = 42;
  const rumbleGain = audio.createGain();
  rumbleGain.gain.setValueAtTime(0.0001, now);
  rumbleGain.gain.exponentialRampToValueAtTime(0.4, now + 0.4);
  rumbleGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.8);
  rumble.connect(rumbleGain).connect(audio.destination);
  rumble.start(now);
  rumble.stop(now + 3);

  setTimeout(() => audio.close(), (duration + 1) * 1000);
}

function placeBubble() {
  if (!bubble.classList.contains('shown')) return;
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  bubble.style.left = `${clamp(pos.x + ghostWidth - w, 8, width - w - 8)}px`;
  bubble.style.top = `${clamp(pos.y - h - 12, 8, height - h - 8)}px`;
}

function hideBubble() {
  clearTimeout(hideTimer);
  bubble.classList.remove('shown');
}

function showBubble(text) {
  bubble.textContent = text;
  bubble.classList.add('shown');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideBubble, bubbleMs);
}

bubble.addEventListener('click', hideBubble);

ghost.addEventListener('pointerdown', (event) => {
  dragging = { x: event.screenX, y: event.screenY };
  ghost.setPointerCapture(event.pointerId);
});
ghost.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  pos = clampToScreen({ x: pos.x + event.screenX - dragging.x, y: pos.y + event.screenY - dragging.y });
  target = { ...pos };
  dragging = { x: event.screenX, y: event.screenY };
});
ghost.addEventListener('pointerup', (event) => {
  dragging = null;
  ghost.releasePointerCapture(event.pointerId);
});

function frame(now) {
  stepTween(now);
  stepBehaviour();
  easeTowardTarget();
  drawParticles();
  ghost.style.left = `${pos.x}px`;
  ghost.style.top = `${pos.y}px`;
  placeBubble();
  updatePupils();
  updateHover();
  requestAnimationFrame(frame);
}

api.onCursor((point) => {
  cursor = point;
});
api.onMode((next) => {
  mode = next;
  document.body.classList.toggle('possessed', next.possessed);
});
api.onMessage(({ text }) => {
  // The first interruption in a possessed session gets one flash and thunder, if Lightning is on.
  if (mode.possessed && mode.lightning && !flashedThisSession) {
    flashedThisSession = true;
    lightning();
  }
  showBubble(text);
});
api.onDemo(({ effect }) => {
  if (effect === 'flee') {
    const c = centre();
    fakeCursor = { x: c.x - 40, y: c.y - 30 };
    fakeUntil = performance.now() + 2500;
  } else if (effect === 'splatter') {
    if (!busy) splatter();
  } else if (effect === 'lightning') {
    lightning();
  } else if (effect === 'peek') {
    if (!busy) peek();
  } else if (effect === 'shiver') {
    shiver();
  } else if (effect === 'candle') {
    candleFlicker();
  } else if (effect === 'ink') {
    if (!busy) ink();
  }
});

requestAnimationFrame(frame);

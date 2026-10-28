// Renderer for the ghost window. The main process owns the window, so this only draws and reports pointer state.
const api = window.paperclip;
const ghost = document.getElementById('ghost');
const bubble = document.getElementById('bubble');
const pupilLeft = document.getElementById('pupilLeft');
const pupilRight = document.getElementById('pupilRight');

const maxPupilOffset = 6;
const bubbleMs = 12_000;
let cursor = null; // relative to the window, from the main process
let hideTimer = null;
let hoverCount = 0;
let drag = null;

function setPupils(offsetX, offsetY) {
  pupilLeft.setAttribute('cx', 82 + offsetX);
  pupilLeft.setAttribute('cy', 112 + offsetY);
  pupilRight.setAttribute('cx', 118 + offsetX);
  pupilRight.setAttribute('cy', 112 + offsetY);
}

// Normal mode: pupils follow the cursor. Possessed mode: pupils stare straight ahead.
function followCursor() {
  if (cursor && !document.body.classList.contains('possessed')) {
    const rect = ghost.getBoundingClientRect();
    const dx = Math.max(-1, Math.min(1, (cursor.x - (rect.left + rect.width / 2)) / 300));
    const dy = Math.max(-1, Math.min(1, (cursor.y - (rect.top + rect.height / 2)) / 300));
    setPupils(dx * maxPupilOffset, dy * maxPupilOffset);
  } else {
    setPupils(0, 0);
  }
  requestAnimationFrame(followCursor);
}

function hideBubble() {
  clearTimeout(hideTimer);
  bubble.classList.remove('shown');
  setHover(false);
}

function showBubble(text) {
  bubble.textContent = text;
  bubble.classList.add('shown');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideBubble, bubbleMs);
}

// The window is click-through except over the ghost and the bubble, so ask the main process to let clicks through when neither is hovered.
function setHover(on) {
  api.setHover(on);
}

for (const element of [ghost, bubble]) {
  element.addEventListener('pointerenter', () => {
    hoverCount += 1;
    setHover(true);
  });
  element.addEventListener('pointerleave', () => {
    hoverCount = Math.max(0, hoverCount - 1);
    if (hoverCount === 0 && !drag) setHover(false);
  });
}

bubble.addEventListener('click', hideBubble);

ghost.addEventListener('pointerdown', (event) => {
  drag = { x: event.screenX, y: event.screenY };
  ghost.setPointerCapture(event.pointerId);
  ghost.style.cursor = 'grabbing';
});
ghost.addEventListener('pointermove', (event) => {
  if (!drag) return;
  api.drag(event.screenX - drag.x, event.screenY - drag.y);
  drag = { x: event.screenX, y: event.screenY };
});
ghost.addEventListener('pointerup', (event) => {
  drag = null;
  ghost.releasePointerCapture(event.pointerId);
  ghost.style.cursor = 'grab';
  if (hoverCount === 0) setHover(false);
});

api.onCursor((point) => { cursor = point; });
api.onMode(({ possessed }) => document.body.classList.toggle('possessed', possessed));
api.onMessage(({ text }) => showBubble(text));

requestAnimationFrame(followCursor);

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');

// Screenshot mode: PAPERCLIP_SNAPSHOT=<file.png> renders the window on white, saves only the window, and quits.
const snapshotPath = process.env.PAPERCLIP_SNAPSHOT;

// Thunder is synthesized with Web Audio, and the demo should play without a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Must match src/shared.ts.
const uiPort = 47831;
const temporalAddress = '127.0.0.1:7233';
const workflowId = 'paperclip-glance';
const askSignal = 'askGhost';

const cursorMs = 50;
const modeMs = 60_000;
const cooldownMs = 3 * 60_000;
// "Ask the ghost" steps through each effect in turn. Lightning is only shown in possessed mode.
const demoSteps = ['line', 'suggest', 'flee', 'splatter', 'lightning', 'peek', 'shiver', 'candle', 'ink'];

let win = null;
let tray = null;
let manualPossessed = null; // null means automatic: possessed between midnight and 5am
let lightningOn = true;
let lastHour = new Date().getHours();
let lastShownAt = 0;
let demoIndex = 0;

if (!app.requestSingleInstanceLock()) app.quit();

function isPossessed() {
  if (process.env.PAPERCLIP_POSSESSED === '1') return true; // for screenshots and recordings
  return manualPossessed ?? new Date().getHours() < 5;
}

// A window can be destroyed while timers still hold a reference to it.
function liveWindow() {
  return win && !win.isDestroyed() ? win : null;
}

function sendMode() {
  liveWindow()?.webContents.send('mode', { possessed: isPossessed(), lightning: lightningOn });
  rebuildMenu();
}

// The window covers the whole display and is click-through, so the ghost can move anywhere.
function createWindow() {
  const display = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
    frame: false,
    transparent: !snapshotPath,
    backgroundColor: snapshotPath ? '#FFFFFF' : undefined,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Clicks pass through the window. The renderer switches this off while the pointer is over the ghost or bubble.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', sendMode);
  // Errors from the renderer show up in the UI log, so effects that fail are visible in the terminal.
  win.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));
  win.on('closed', () => {
    win = null;
  });
  if (snapshotPath) {
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(snapshotPath, image.toPNG());
      app.quit();
    }, 4_000);
  }
}

// Asks the worker for an interruption on its next glance. The mode is 'line' or 'suggest'.
async function askGhost(mode) {
  const { Client, Connection } = await import('@temporalio/client');
  const connection = await Connection.connect({ address: temporalAddress });
  try {
    await new Client({ connection }).workflow.getHandle(workflowId).signal(askSignal, mode);
    console.log(`[ask] ${mode} signal sent`);
  } finally {
    await connection.close();
  }
}

// Each press of "Ask the ghost" shows the next effect. Worker effects go through the worker, the rest run in the window.
function askDemo() {
  for (let tries = 0; tries < demoSteps.length; tries += 1) {
    const step = demoSteps[demoIndex % demoSteps.length];
    demoIndex += 1;
    if (step === 'lightning' && !isPossessed()) continue;
    if (step === 'line' || step === 'suggest') {
      askGhost(step).catch((error) => console.error(`[ask] failed: ${error.message}`));
    } else {
      liveWindow()?.webContents.send('demo', { effect: step });
    }
    console.log(`[ask] demo: ${step}`);
    return;
  }
}

// Minimal 16x16 PNG for the menu bar: a ghost silhouette with two eye holes, drawn as a template image.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function ghostIcon() {
  const size = 16;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const head = y <= 7 && (x - 7.5) ** 2 + (y - 7) ** 2 <= 20;
      const body = y >= 7 && y <= 12 && x >= 3 && x <= 12;
      const eye = y === 6 && (x === 6 || x === 9);
      const inside = (head || body) && !eye;
      row.set([0, 0, 0, inside ? 255 : 0], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const image = nativeImage.createFromBuffer(png);
  image.setTemplateImage(true);
  return image;
}

function rebuildMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Possessed mode',
      type: 'checkbox',
      checked: isPossessed(),
      click: () => {
        manualPossessed = !isPossessed();
        sendMode();
      },
    },
    {
      label: 'Lightning',
      type: 'checkbox',
      checked: lightningOn,
      click: () => {
        lightningOn = !lightningOn;
        sendMode();
      },
    },
    {
      label: 'Ask the ghost',
      click: askDemo,
    },
  ]));
}

function createTray() {
  tray = new Tray(ghostIcon());
  tray.setToolTip('Paperclip');
  rebuildMenu();
}

// Messages from the worker's show step, and demo messages: one JSON object per line.
function startMessageServer() {
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        deliver(line);
        newline = buffered.indexOf('\n');
      }
    });
    socket.on('error', () => {});
  });
  server.listen(uiPort, '127.0.0.1', () => console.log(`[ui] listening on 127.0.0.1:${uiPort}`));
}

function deliver(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.log('[ui] dropped a malformed message');
    return;
  }
  if (message.demo) {
    liveWindow()?.webContents.send('demo', { effect: message.demo });
    return;
  }
  const now = Date.now();
  // Explicit "Ask the ghost" requests bypass the cooldown.
  if (!message.forced && now - lastShownAt < cooldownMs) {
    console.log('[ui] dropped an interruption inside the 3 minute cooldown');
    return;
  }
  lastShownAt = now;
  console.log(`[ui] ${message.kind}: ${message.text}`);
  liveWindow()?.webContents.send('message', { text: message.text, kind: message.kind });
}

ipcMain.on('hover', (_event, over) => {
  liveWindow()?.setIgnoreMouseEvents(!over, { forward: true });
});

app.whenReady().then(() => {
  app.dock?.hide();
  createWindow();
  createTray();
  startMessageServer();

  setInterval(() => {
    const target = liveWindow();
    if (!target) return;
    const point = screen.getCursorScreenPoint();
    const origin = target.getBounds();
    target.webContents.send('cursor', { x: point.x - origin.x, y: point.y - origin.y });
  }, cursorMs);

  // Possessed mode follows the clock. A manual toggle lasts until the next midnight or 5am boundary.
  setInterval(() => {
    const hour = new Date().getHours();
    if (hour !== lastHour) {
      lastHour = hour;
      if (hour === 0 || hour === 5) manualPossessed = null;
    }
    sendMode();
  }, modeMs);
});

// The ghost has no quit item. Closing its windows keeps it running, and launchd restarts it if it is force-quit.
app.on('window-all-closed', () => {});

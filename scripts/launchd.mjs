import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
const logsDir = join(homedir(), 'Library', 'Logs');
const domain = `gui/${userInfo().uid}`;
// The electron package exports the path to its binary.
const electronBinary = createRequire(import.meta.url)('electron');

// The Temporal CLI is found on PATH. setup installs it if it is missing.
function temporalBinary() {
  try {
    return execFileSync('which', ['temporal'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// Order matters: the Temporal server starts first, then the worker and the UI.
function agents() {
  const list = [];
  const temporal = temporalBinary();
  if (temporal) {
    list.push({
      label: 'com.paperclip.temporal',
      args: [
        temporal, 'server', 'start-dev', '--headless', '--log-level', 'warn',
        '--db-filename', join(projectDir, 'paperclip.db'), '--ip', '127.0.0.1',
      ],
      log: join(logsDir, 'paperclip-temporal.log'),
    });
  }
  list.push(
    {
      label: 'com.paperclip.worker',
      args: [process.execPath, `--env-file-if-exists=${join(projectDir, '.env')}`, join(projectDir, 'dist', 'worker.js')],
      log: join(logsDir, 'paperclip-worker.log'),
    },
    {
      label: 'com.paperclip.ui',
      args: [electronBinary, join(projectDir, 'ui')],
      log: join(logsDir, 'paperclip-ui.log'),
    },
  );
  return list;
}

function plist({ label, args, log }) {
  const programArguments = args.map((arg) => `    <string>${arg}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${projectDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function plistPath(label) {
  return join(agentsDir, `${label}.plist`);
}

function launchctl(...args) {
  return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isLoaded(label) {
  try {
    launchctl('print', `${domain}/${label}`);
    return true;
  } catch {
    return false;
  }
}

// bootout returns before launchd has finished stopping the job. Bootstrapping during that window fails with I/O error 5.
function unload(label) {
  try {
    launchctl('bootout', `${domain}/${label}`);
  } catch {
    // Not loaded, which is fine.
  }
  for (let wait = 0; wait < 10 && isLoaded(label); wait += 1) {
    execFileSync('sleep', ['1']);
  }
}

function bootstrap(label) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      launchctl('bootstrap', domain, plistPath(label));
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      execFileSync('sleep', ['1']);
    }
  }
}

// Labels for uninstall and stop, which must work even when the Temporal CLI has been removed.
const allLabels = ['com.paperclip.temporal', 'com.paperclip.worker', 'com.paperclip.ui'];

const command = process.argv[2];

if (command === 'install') {
  const list = agents();
  if (!list.some((agent) => agent.label === 'com.paperclip.temporal')) {
    console.error('Temporal CLI not found on PATH. Install it with: brew install temporal');
    process.exit(1);
  }
  await mkdir(agentsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  for (const agent of list) {
    await writeFile(plistPath(agent.label), plist(agent));
    unload(agent.label);
    bootstrap(agent.label);
    console.log(`Installed ${agent.label}. Logs: ${agent.log}`);
  }
} else if (command === 'uninstall') {
  for (const label of [...allLabels].reverse()) {
    unload(label);
    await rm(plistPath(label), { force: true });
    console.log(`Uninstalled ${label}.`);
  }
} else if (command === 'stop') {
  for (const label of [...allLabels].reverse()) {
    unload(label);
    console.log(`Stopped ${label}.`);
  }
} else if (command === 'start') {
  for (const agent of agents()) {
    if (!existsSync(plistPath(agent.label))) {
      console.error(`${agent.label} is not installed. Run npm run install-worker first.`);
      process.exit(1);
    }
    unload(agent.label);
    bootstrap(agent.label);
    console.log(`Started ${agent.label}.`);
  }
} else {
  console.error('Usage: node scripts/launchd.mjs install|uninstall|stop|start');
  process.exit(1);
}

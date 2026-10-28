import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const label = 'com.paperclip.worker';
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
const plistPath = join(agentsDir, `${label}.plist`);
const logPath = join(homedir(), 'Library', 'Logs', 'paperclip-worker.log');
const domain = `gui/${userInfo().uid}`;

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(projectDir, 'dist', 'worker.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${projectDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function unload() {
  try {
    launchctl('bootout', `${domain}/${label}`);
  } catch {
    // Not loaded, which is fine.
  }
}

const command = process.argv[2];

if (command === 'install') {
  await mkdir(agentsDir, { recursive: true });
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(plistPath, plist());
  unload();
  launchctl('bootstrap', domain, plistPath);
  console.log(`Installed ${label}. Logs: ${logPath}`);
} else if (command === 'uninstall') {
  unload();
  await rm(plistPath, { force: true });
  console.log(`Uninstalled ${label}.`);
} else {
  console.error('Usage: node scripts/launchd.mjs install|uninstall');
  process.exit(1);
}

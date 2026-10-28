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

const agents = [
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
];

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

function unload(label) {
  try {
    launchctl('bootout', `${domain}/${label}`);
  } catch {
    // Not loaded, which is fine.
  }
}

const command = process.argv[2];

if (command === 'install') {
  await mkdir(agentsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  for (const agent of agents) {
    await writeFile(plistPath(agent.label), plist(agent));
    unload(agent.label);
    launchctl('bootstrap', domain, plistPath(agent.label));
    console.log(`Installed ${agent.label}. Logs: ${agent.log}`);
  }
} else if (command === 'uninstall') {
  for (const agent of agents) {
    unload(agent.label);
    await rm(plistPath(agent.label), { force: true });
    console.log(`Uninstalled ${agent.label}.`);
  }
} else if (command === 'stop') {
  for (const agent of agents) {
    unload(agent.label);
    console.log(`Stopped ${agent.label}.`);
  }
} else if (command === 'start') {
  for (const agent of agents) {
    if (!existsSync(plistPath(agent.label))) {
      console.error(`${agent.label} is not installed. Run npm run install-worker first.`);
      process.exit(1);
    }
    unload(agent.label);
    launchctl('bootstrap', domain, plistPath(agent.label));
    console.log(`Started ${agent.label}.`);
  }
} else {
  console.error('Usage: node scripts/launchd.mjs install|uninstall|stop|start');
  process.exit(1);
}

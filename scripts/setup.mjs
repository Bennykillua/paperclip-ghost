import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

// First-time setup for Paperclip. Checks the prerequisites, lets you choose the vision model, builds, and starts the agents.
// Flags: --no-launchd skips installing the background agents (used for testing a clean copy).
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(projectDir, '.env');
const ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const skipLaunchd = process.argv.includes('--no-launchd');

const models = [
  { value: 'gemma4:e2b', note: 'default, good detail, about 3 seconds per glance' },
  { value: 'moondream', note: 'fastest, least detail' },
  { value: 'qwen2.5vl:3b', note: 'in between, about 5 seconds per glance' },
];

// Reads one answer per question. Works at a terminal and with piped input.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const answers = rl[Symbol.asyncIterator]();
async function ask(question) {
  process.stdout.write(question);
  const { value, done } = await answers.next();
  return done ? '' : value;
}

function step(title) {
  console.log(`\n== ${title}`);
}

function has(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function confirm(question, fallback = true) {
  const suffix = fallback ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${question} ${suffix} `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith('y');
}

function fail(message) {
  console.error(`\n${message}`);
  rl.close();
  process.exit(1);
}

async function ollamaRunning() {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

// Ollama lists a bare name as name:latest. A name that already has a tag is compared as it is.
async function modelInstalled(name) {
  const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  const { models = [] } = await response.json();
  const wanted = name.includes(':') ? name : `${name}:latest`;
  return models.some((model) => model.name === wanted);
}

async function main() {
  step('Checking this Mac');
  if (process.platform !== 'darwin') fail('Paperclip runs on macOS only (screencapture, osascript and launchd are required).');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) fail(`Node 20 or newer is needed. This is ${process.version}.`);
  console.log(`macOS, Node ${process.version}`);

  step('Temporal CLI');
  if (has('temporal')) {
    console.log('Found the Temporal CLI.');
  } else if (has('brew') && (await confirm('The Temporal CLI is missing. Install it with Homebrew now?'))) {
    execFileSync('brew', ['install', 'temporal'], { stdio: 'inherit' });
  } else {
    fail('Install the Temporal CLI (brew install temporal, or from temporal.io), then run npm run setup again.');
  }

  step('Ollama');
  if (!has('ollama')) {
    if (has('brew') && (await confirm('Ollama is missing. Install it with Homebrew now?'))) {
      execFileSync('brew', ['install', 'ollama'], { stdio: 'inherit' });
    } else {
      fail('Install Ollama from ollama.com, then run npm run setup again.');
    }
  }
  if (!(await ollamaRunning())) {
    console.log('Starting Ollama in the background...');
    spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
    for (let wait = 0; wait < 15 && !(await ollamaRunning()); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!(await ollamaRunning())) fail('Ollama is not responding. Open the Ollama app, then run npm run setup again.');
  }
  console.log('Ollama is running.');

  step('Vision model');
  models.forEach((model, index) => console.log(`  ${index + 1}) ${model.value}  (${model.note})`));
  const choice = (await ask('Choose a model [1]: ')).trim() || '1';
  const picked = models[Number(choice) - 1];
  const model = picked ? picked.value : choice;
  if (!picked && !choice.includes(':')) fail(`"${choice}" is not one of the options. Enter 1, 2 or 3, or a model name such as llava:7b.`);
  if (await modelInstalled(model)) {
    console.log(`${model} is already on this Mac.`);
  } else if (await confirm(`${model} is not on this Mac. Download it now? It can be several GB.`)) {
    execFileSync('ollama', ['pull', model], { stdio: 'inherit' });
  } else {
    fail(`Paperclip needs ${model} to look at the screen. Run npm run setup again when you are ready to download it.`);
  }

  // Keep any existing .env values and set only the model.
  const existing = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
  const lines = existing.split('\n').filter((line) => line.length && !line.startsWith('VISION_MODEL='));
  lines.push(`VISION_MODEL=${model}`);
  await writeFile(envPath, `${lines.join('\n')}\n`);
  console.log(`Saved VISION_MODEL=${model} to .env`);

  step('Dependencies and build');
  execFileSync('npm', ['install'], { cwd: projectDir, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: projectDir, stdio: 'inherit' });

  if (skipLaunchd) {
    console.log('\nSkipped the background agents (--no-launchd).');
  } else {
    step('Background agents');
    execFileSync('node', [join(projectDir, 'scripts', 'launchd.mjs'), 'install'], { cwd: projectDir, stdio: 'inherit' });
  }

  step('Permissions');
  console.log('macOS asks for two permissions the first time the ghost looks at your screen:');
  console.log('  - Screen Recording for "node" (/usr/local/bin/node or your Homebrew node) and for Electron (node_modules/electron/dist/Electron.app).');
  console.log('  - Accessibility for the window title, if prompted.');
  console.log('Grant them in System Settings > Privacy & Security, then run npm run ghost:start.');

  step('Try it');
  console.log('  npm run ghost:test -- line       a line about what is on screen');
  console.log('  npm run ghost:test -- suggest    a suggestion about a notable item');
  console.log('  npm run ghost:test -- all        every effect in turn');
  console.log('  npm run ghost:stop               stop everything');
  rl.close();
}

main().catch((error) => fail(error.message));

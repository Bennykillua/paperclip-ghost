import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const models = ['moondream:latest', 'qwen2.5vl:3b', 'gemma4:e2b'];
const numPredict = 150;
const maxImageSide = 1280;
const switchSeconds = Number(process.env.SWITCH_SECONDS ?? 10);
const prompt = 'Describe what is visible on this screen in a concise, factual paragraph. Do not guess at information that is not visible.';

async function getInstalledModels() {
  const response = await fetch(`${ollamaUrl}/api/tags`);
  if (!response.ok) {
    throw new Error(`Could not list Ollama models: ${response.status} ${response.statusText}`);
  }
  const { models: installed = [] } = await response.json();
  return new Set(installed.map(({ name }) => name));
}

async function captureScreen(path) {
  for (let remaining = switchSeconds; remaining > 0; remaining -= 1) {
    process.stdout.write(`\rSwitch to another window, capturing in ${remaining}s...   `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write('\rCapturing now.                                      \n');
  execFileSync('screencapture', ['-x', path]);
  const resizedPath = `${path}.small.png`;
  execFileSync('sips', ['-Z', String(maxImageSide), path, '--out', resizedPath], { stdio: 'ignore' });
  return (await readFile(resizedPath)).toString('base64');
}

async function describeImage(model, image) {
  const start = performance.now();
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [image],
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: numPredict },
    }),
  });
  const wallMs = performance.now() - start;

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`${model} request failed: ${response.status} ${details}`);
  }

  const result = await response.json();
  if (!result.response?.trim()) {
    throw new Error(`${model} returned an empty description`);
  }
  return {
    text: result.response.trim(),
    wallMs,
    tokens: result.eval_count,
    tokensPerSecond: result.eval_count / (result.eval_duration / 1e9),
    doneReason: result.done_reason,
  };
}

const installedModels = await getInstalledModels();
const missingModels = models.filter((model) => !installedModels.has(model));
if (missingModels.length) {
  throw new Error(`Required model(s) not installed: ${missingModels.join(', ')}`);
}

const tempDir = await mkdtemp(join(tmpdir(), 'paperclip-vision-'));
const screenshotPath = join(tempDir, 'screen.png');

try {
  for (const model of models) {
    console.log(`\n${model}`);

    const warmUp = await describeImage(model, await captureScreen(screenshotPath));
    console.log(`Warm-up (not counted): ${(warmUp.wallMs / 1000).toFixed(2)}s, ${warmUp.tokens} tokens, done: ${warmUp.doneReason}`);

    const runs = [];
    for (let run = 0; run < 3; run += 1) {
      const result = await describeImage(model, await captureScreen(screenshotPath));
      runs.push(result);
      console.log(
        `Run ${run + 1}: ${(result.wallMs / 1000).toFixed(2)}s, ${result.tokens} tokens, ` +
        `${result.tokensPerSecond.toFixed(1)} tok/s, done: ${result.doneReason}`,
      );
    }

    const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    console.log(`Average time: ${(average(runs.map((run) => run.wallMs)) / 1000).toFixed(2)}s`);
    console.log(`Average tokens: ${average(runs.map((run) => run.tokens)).toFixed(1)}`);
    console.log(`Average tokens/s: ${average(runs.map((run) => run.tokensPerSecond)).toFixed(1)}`);
    console.log(`Sample description: ${runs[0].text}`);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

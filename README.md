# Paperclip

A desktop ghost for macOS that watches what you're doing and butts in. It runs a local vision model through Ollama, so nothing about your screen leaves your machine.

## What you need

- A Mac
- Node.js 20 or newer
- Homebrew (setup offers to install the rest with it)

Setup installs the Temporal CLI and Ollama if they're missing, with your permission.

## Install and use

Four steps. Setup does the rest.

```sh
git clone https://github.com/Bennykillua/paperclip-ghost.git
cd paperclip-ghost
npm run setup              # checks the tools, asks for a model, builds, starts the agents
npm run ghost:test -- all  # see every effect once
```

Settings live in `.env`. `.env.example` lists them with notes. Setup writes `VISION_MODEL` for you, and Sentry stays off until you add `SENTRY_DSN`.

The command-line tools are listed in `Brewfile`. `brew bundle` installs them.

Then give macOS the two permissions in [Permissions](#permissions) and run `npm run ghost:start`. The ghost starts on login and comes back if it is killed.

Setup does these steps, asking before each download:

1. Checks macOS and Node 20 or newer.
2. Installs the Temporal CLI and Ollama with Homebrew, if they are missing and you say yes.
3. Asks which vision model to use, and downloads it only if it is not already on your Mac.
4. Builds the project and installs three background agents: Temporal, the worker and the ghost window.

To remove everything, run `npm run ghost:stop`, then `node scripts/launchd.mjs uninstall`, then delete the folder.

Setup asks which vision model to use:

1. `gemma4:e2b`: the default, good detail, about 3 seconds per glance
2. `moondream`: the fastest, least detail
3. `qwen2.5vl:3b`: in between, about 5 seconds per glance

Your choice is saved to `.env` as `VISION_MODEL`. Setup then builds the project and installs three background agents: the Temporal server, the worker, and the ghost window.

## Permissions

The first time the ghost looks at your screen, macOS asks for permissions. Grant them in **System Settings > Privacy & Security**:

- **Screen Recording** for `node` (for example `/usr/local/bin/node` or your Homebrew node) and for Electron (`node_modules/electron/dist/Electron.app`).
- **Accessibility** for the window title, if asked.

Then run `npm run ghost:start` so the agents pick them up.

## Try it

From a terminal in the project folder:

```sh
npm run ghost:test -- line       # a line about what is on screen
npm run ghost:test -- suggest    # a suggestion about a notable item
npm run ghost:test -- flee       # the ghost runs from the cursor
npm run ghost:test -- splatter   # red ink splatter, then the ghost reforms
npm run ghost:test -- lightning  # one soft flash with thunder
npm run ghost:test -- peek       # the ghost peeks in from the edge
npm run ghost:test -- shiver     # the ghost trembles
npm run ghost:test -- candle     # a warm flicker along the bottom
npm run ghost:test -- ink        # the ghost glides and leaves a red trail
npm run ghost:test -- message "hello"
npm run ghost:test -- all        # every effect in turn
```

The window covers the whole screen and passes clicks through, so your terminal stays usable underneath.

## Stop and start

```sh
npm run ghost:stop     # stops the Temporal server, the worker and the ghost
npm run ghost:start    # starts them again
```

## Logs

- `~/Library/Logs/paperclip-temporal.log`
- `~/Library/Logs/paperclip-worker.log`
- `~/Library/Logs/paperclip-ui.log`

## Sentry (optional)

Sentry tracing is off unless `SENTRY_DSN` is in `.env`. When it is on, it receives timings, event names, token counts and the model name. It never receives screenshots, window titles, prompts or model output.

## Privacy

Screenshots, window titles and model descriptions stay on your machine. The vision model and the lines it writes run locally through Ollama, and the UI makes no network requests.

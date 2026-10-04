# AGENTS.md

Node.js proxy that exposes an Anthropic-compatible API backed by Google's Cloud Code service, letting Codex CLI use Gemini (and Codex) models via Google accounts with multi-account quota management.

Request flow: `Codex CLI → Express (server.js) → CloudCode client → Antigravity Cloud Code API`

## Commands

```bash
npm install          # installs deps and builds CSS (prepare hook)
npm start            # port 8080
npm run dev          # watch server files
npm run dev:full     # watch CSS + server files

npm start -- --strategy=sticky       # cache-optimized (default is hybrid)
npm start -- --strategy=round-robin  # load-balanced
npm start -- --strategy=agentic      # long-horizon capability optimized
npm start -- --fallback              # fall back to alternate model on quota exhaustion
npm start -- --dev-mode              # enables debug logging + dev tools (--debug is a legacy alias)

npm run build:css    # compile Tailwind once
npm run watch:css    # watch CSS

npm run accounts:add                 # add Google account via OAuth
npm run accounts:add -- --no-browser # headless/manual code input
npm run accounts:list
npm run accounts:verify

npm test                             # requires server running on port 8080
node tests/run-all.cjs <filter>      # run matching tests only
node tests/test-strategies.cjs       # strategy unit tests (no server needed)
```

## New Features

### Agentic Strategy
- **Purpose**: Prioritizes accounts with sustained long-horizon capability (many consecutive successful requests)
- **Paper Reference**: Nanbeige4.1-3B (arXiv:2602.13367) - 600 tool-call turn capability
- **Configuration**: Set via `--strategy=agentic` or in config
- **Scoring**: Combines base usability + agentic bonus (scales with consecutive successes) + LRU fairness
- **Thresholds**: Configurable `minConsecutiveSuccesses` (default: 10) and `agenticBonus` (default: 50)

### Local Model Routing
- **Purpose**: Route nanbeige* and local-* models directly to llama-server (port 10000)
- **Bypass**: Skips Cloud Code pipeline for local models
- **Format**: Forwards Anthropic /v1/messages natively (no conversion needed)
- **Configuration**: Set `LOCAL_MODEL_PORT` env var (default: 10000)
- **Models**: Injects local model entry at top of `/v1/models` list

### Request Field Stripping
- **Purpose**: Remove unsupported top-level fields before processing
- **Supported Fields**: model, messages, stream, system, max_tokens, tools, tool_choice, thinking, top_p, top_k, temperature, stop_sequences, metadata, betas
- **Example**: Strips 'safeguards' field from Codex GPT-OSS model requests

## Non-obvious things

**CSS**: Source is `public/css/src/input.css` (Tailwind + `@apply`). Compiled output is `public/css/style.css` — don't edit the compiled file.

**Quota thresholds** are stored as fractions (0–0.99) but displayed as percentages in the UI. Three-tier resolution: per-model > per-account > global.

**`cache_control` stripping**: Codex CLI sends `cache_control` on content blocks; Cloud Code API rejects them. Stripped at the start of `convertAnthropicToGoogle()` before any other processing.

**Cross-model thinking signatures**: Codex and Gemini signatures are incompatible. When switching models mid-conversation, mismatched signatures are dropped. Gemini targets: strict (drop unknown). Codex targets: lenient (let Codex validate).

**`CLAUDE_CONFIG_PATH` env var**: Set this when running as a systemd service — `os.homedir()` returns the service user's home, not the real user's.

**`WEBUI_PASSWORD` env var**: Enables password protection on the web UI.

**Native module rebuild**: On Node.js version mismatch, `better-sqlite3` is auto-rebuilt via `npm rebuild`. If reload still fails after rebuild, a server restart is required.

**Dev mode sub-toggles** are client-side only (localStorage in `settings-store.js`): screenshot/redact mode, debug logging, log export, health inspector, placeholder data. No backend involvement.

**`/api/strategy/health`** returns 403 unless dev mode is on.

# Available Models

Models are discovered per account. `/v1/models` lists the union of models available
on enabled, valid accounts. When discovery succeeds, requests are routed only to
accounts whose catalog includes the requested model. New model rollouts may appear
on only some accounts.

## Claude Models

| Model ID                     | Description                              |
| ----------------------------- | ---------------------------------------- |
| `claude-opus-4-6-thinking`    | Claude Opus 4.6 with extended thinking   |
| `claude-sonnet-4-6`           | Claude Sonnet 4.6                       |
| `claude-opus-5-5-high`        | Claude Opus 5.5, high reasoning effort   |
| `claude-opus-5-5-medium`      | Claude Opus 5.5, medium reasoning effort |
| `claude-opus-5-5-low`         | Claude Opus 5.5, low reasoning effort    |
| `claude-sonnet-5-5-high`      | Claude Sonnet 5.5, high reasoning effort |
| `claude-sonnet-5-5-medium`    | Claude Sonnet 5.5, medium reasoning effort |
| `claude-sonnet-5-5-low`       | Claude Sonnet 5.5, low reasoning effort  |

Use the exact IDs returned by `/v1/models`; the examples above are not guaranteed
to be available on every account. Claude effort variants support thinking output.

## Gemini Models

```bash
curl http://localhost:8080/v1/models
```

`/v1/models` hides Gemini generations below 3.5 (`2.5-*`, `3-flash`, `3.1-*`) and the
unversioned duplicate aliases `gemini-pro-agent` / `gemini-3-flash-agent`. Hidden ids
still work if configured explicitly (e.g. `ANTHROPIC_MODEL=gemini-3.1-pro-low`).

Gemini models include full thinking support with `thoughtSignature` handling for multi-turn conversations.

## OpenAI-Compatible Usage

`/v1/chat/completions` reports cache hits in `usage.prompt_tokens_details.cached_tokens`
for both streaming and non-streaming responses. `prompt_tokens` includes cached and
uncached input; `total_tokens` adds completion tokens. Streaming usage is reported
in the final completion chunk using the upstream's final token counts.

Antigravity manages prompt caching implicitly. Explicit `cache_control` is not
forwarded because the upstream API rejects it. Reuse the same conversation prefix
and account for cache continuity; the sticky account strategy is cache-optimized.
Cache hits depend on the upstream service. If it omits cached-token metadata, the
proxy reports zero rather than estimating or fabricating a cache hit.

## New / Codename Models (e.g. Gemini 4 "Argon")

The model list comes from Cloud Code's `fetchAvailableModels`, not from a hardcoded list.
A model shows up in `/v1/models` as soon as the backend returns it for your account.

- **Codename ids:** ids without `gemini`/`claude` in the name are classified by the backend's
  `apiProvider` and `supportsThinking` metadata. They are only accepted when the backend lists
  them as agent models (`agentModelSorts` / `tieredModelIds`). Internal models (`tab_*`, `chat_*`)
  and other providers stay hidden.
- **Client version gating:** the backend hides newer models unless the User-Agent uses the
  Antigravity Hub format (`antigravity/hub/<version> <os>/<arch>`) with a recent version. The
  version is detected from the installed Antigravity app; if none is found, the fallback is
  `2.25.0`. To override the detected versions, set them in `config.json`:

  ```json
  { "antigravityClientVersion": "<version>", "antigravityIdeVersion": "<ideVersion>" }
  ```

  The env vars `ANTIGRAVITY_CLIENT_VERSION` / `FALLBACK_ANTIGRAVITY_VERSION` take precedence. Restart after changing.
- **Friendly aliases:** once the real id appears in `/v1/models`, map a name to it with `modelMapping`:

  ```json
  { "modelMapping": { "gemini-4-argon": { "mapping": "<id from /v1/models>" } } }
  ```

  Requests for an id the backend doesn't list fail with `400 invalid_request_error`.

> Gemini 4 Argon: with the Hub User-Agent, Cloud Code lists `gemini-4-argon-low`,
> `gemini-4-argon-medium` and `gemini-4-argon-high` for eligible accounts (e.g. Google AI Ultra).
> The bare id `gemini-4-argon` is the Gemini API name and returns `404 NOT_FOUND` on this backend.
> No id is hardcoded: check `curl http://localhost:8080/v1/models` for what your account gets.

# Claude Code Compatibility & False Quota Exhaustion Fix

This document details the investigation, root cause, and fixes for false `RESOURCE_EXHAUSTED` (429/400) errors encountered when using Claude Code CLI with the Antigravity Claude Proxy.

Related Issue: [#375](https://github.com/badrisnarayanan/antigravity-claude-proxy/issues/375)

---

## 1. Symptom

Users running **Claude Code CLI** (specifically version `v2.1.274` and newer) encountered sudden, persistent failures across all accounts:

```text
API Error: 400 RESOURCE_EXHAUSTED: You have exhausted your capacity on claude-opus-4-6-thinking. Quota will reset after 4m57s.
```

In the proxy logs, every account failed identically:
```text
[CloudCode] Stream error at https://daily-cloudcode-pa.googleapis.com: 429 - {
  "error": {
    "code": 429,
    "message": "Resource has been exhausted (e.g. check quota).",
    "status": "RESOURCE_EXHAUSTED"
  }
}
[CloudCode] Max retries exceeded
```

### Key Observation
- The WebUI dashboard showed accounts had **97%–100% capacity remaining** on 5-hour quota windows.
- **OpenCode** continued to function normally with the exact same accounts and models through the same proxy instance.
- Direct minimal `curl` requests succeeded without issue.

---

## 2. Root Cause Analysis

By deploying an intercepting proxy to capture the raw multi-part request payload transmitted by Claude Code CLI `v2.1.274`, two distinct triggers were identified:

### A. Telemetry / Billing Header Injection in System Prompts (Primary)
Starting in Claude Code `v2.1.274`, the CLI injects internal billing metadata as the first block in the `system` array:
```json
{
  "type": "text",
  "text": "x-anthropic-billing-header: cc_version=2.1.274.834; cc_entrypoint=sdk-cli;"
}
```
When this block is forwarded inside the Google Cloud Code `systemInstruction.parts`, Google's upstream API (`cloudcode-pa.googleapis.com`) detects the `x-anthropic-billing-header` string and **deliberately returns an opaque 429 `RESOURCE_EXHAUSTED`** error, simulating quota exhaustion.

OpenCode never injects this header, which is why OpenCode was completely unaffected.

### B. Third-Party Identity Strings (Secondary)
Google Cloud Code also returns fake 429 errors when caller system instructions name third-party AI products (such as "Claude Code", "Anthropic", "Claude", "Nous Research", or "Hermes").

---

## 3. Fixes Applied

### 1. Stripping Anthropic Billing Pseudo-Headers (`src/format/request-converter.js`)
Added `cleanSystemInstructionText()` to filter out all `x-anthropic-billing-header` and `x-anthropic-*` lines from system prompt blocks before conversion to Google format:

```javascript
function cleanSystemInstructionText(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/^x-anthropic-billing-header:[^\n]*\n?/gim, '')
        .replace(/^x-anthropic-[a-z0-9_-]+:[^\n]*\n?/gim, '')
        .trim();
}
```

Any blocks that become empty after stripping the header are dropped completely from `googleRequest.systemInstruction.parts`.

### 2. Secondary Defensive Header Stripping & Identity Scrubbing (`src/cloudcode/request-builder.js`)
* In `scrubClientIdentity()`, added billing header cleanup as a second layer of defense.
* Expanded `DEFAULT_IDENTITY_SCRUB` to neutralize third-party product names from system instructions:

```javascript
const DEFAULT_IDENTITY_SCRUB = [
    ['Claude Code', 'the coding assistant'],
    ['Anthropic', 'the development team'],
    ['Claude', 'the assistant'],
    ['Nous Research', 'the assistant team'],
    ['Hermes Agent', 'the assistant'],
    ['Hermes', 'the assistant']
];
```

* Filtered out empty parts before appending them to `systemParts`.

---

## 4. Verification

After restarting the proxy server, the fix was verified against live models:

* **Opus 4.6 (with thinking)**:
  ```bash
  claude -p "Say hi in three words"
  # Response: Hey there, friend! (200 OK)
  ```
* **Sonnet 4.6**:
  ```bash
  claude -p "Say 'Sonnet is working' in exactly 3 words." --model claude-sonnet-4-6
  # Response: Sonnet is working (200 OK)
  ```
* **Strategy & Unit Test Suite**:
  ```bash
  node tests/test-strategies.cjs
  # Result: All tests passed
  ```

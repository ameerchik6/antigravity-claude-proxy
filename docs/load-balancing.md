# Multi-Account Load Balancing

When you add multiple accounts, the proxy intelligently distributes requests across them using configurable selection strategies.

## Account Selection Strategies

Choose a strategy based on your needs:

| Strategy | Best For | Description |
| --- | --- | --- |
| **Hybrid** (Default) | Most users | Smart selection combining health score, token bucket rate limiting, quota awareness, and LRU freshness |
| **Sticky** | Prompt caching | Stays on the same account to maximize cache hits, switches only when rate-limited |
| **Round-Robin** | Even distribution | Cycles through accounts sequentially for balanced load |
| **Agentic** | Long-horizon tasks | Prioritizes accounts with sustained streaks of consecutive successes |

**Configure via CLI:**

```bash
antigravity-claude-proxy start --strategy=hybrid       # Default: smart distribution
antigravity-claude-proxy start --strategy=sticky       # Cache-optimized
antigravity-claude-proxy start --strategy=round-robin  # Load-balanced
antigravity-claude-proxy start --strategy=agentic      # Success-streak optimized
```

**Or via WebUI:** Settings → Server → Account Selection Strategy

## How It Works

- **Health Score Tracking**: Accounts earn points for successful requests and lose points for failures/rate-limits
- **Token Bucket Rate Limiting**: Client-side throttling with regenerating tokens (50 max, 6/minute)
- **Quota Awareness**: Accounts below configurable quota thresholds are deprioritized; exhausted accounts trigger emergency fallback
- **Quota Protection**: Set minimum quota levels globally, per-account, or per-model to switch accounts before quota runs out
- **Emergency Fallback**: When all accounts appear exhausted, bypasses checks with throttle delays (250-500ms)
- **Automatic Cooldown**: Rate-limited accounts recover automatically after reset time expires
- **Invalid Account Detection**: Accounts needing re-authentication are marked and skipped
- **Prompt Caching Support**: Session IDs derived from conversation enable cache hits across turns

## Monitoring

Check account status, subscription tiers, and quota anytime:

```bash
# Web UI: http://localhost:8080/ (Accounts tab - shows tier badges and quota progress)
# CLI Table:
curl "http://localhost:8080/account-limits?format=table"
```

### CLI Management Reference

If you prefer using the terminal for management:

```bash
# List all accounts
antigravity-claude-proxy accounts list

# Verify account health
antigravity-claude-proxy accounts verify

# Interactive CLI menu
antigravity-claude-proxy accounts
```

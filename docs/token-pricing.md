# Token value estimates

Rates checked on 2026-10-28. Values in the UI are **current API token-value estimates in USD** at each model's official list price, not invoices, subscription charges, or historical prices. Rates are a versioned snapshot in `src/shared/pricing.ts`; they do not update automatically.

| Model | Input / 1M | Cached read / 1M | Cache write / 1M | Output / 1M |
|---|---:|---:|---:|---:|
| GPT-6 Astra | $10 | $1 | $12.50 | $50 |
| GPT-6.1 Sol | $2 | $0.10 | $2.50 | $10 |
| GPT-6 Sol | $2 | $0.20 | $2.50 | $10 |
| GPT-6.1 Terra | $1 | $0.05 | $1.25 | $5 |
| GPT-6 Luna | $0.10 | $0.01 | $0.125 | $0.50 |
| GPT-5.6 Sol | $4 | $0.40 | $5 | $20 |
| GPT-5.6 Terra | $2 | $0.20 | $2.50 | $12 |
| GPT-5.6 Luna | $0.20 | $0.02 | $0.25 | $1.20 |
| GPT-5.5 | $5 | $0.50 | $6.25 | $30 |
| Claude Fable 5.1 | $10 | $0.25 | $12.50 / $20 | $50 |
| Claude Opus 5.5 | $4 | $0.20 | $5 / $8 | $20 |
| Claude Sonnet 5.5 | $2 | $0.10 | $2.50 / $4 | $10 |
| Claude Haiku 5.5 (≤ 100K input) | $0.10 | $0.01 | $0.125 / $0.20 | $0.50 |
| Claude Haiku 5.5 (> 100K input) | $0.50 | $0.05 | $0.625 / $1 | $2.50 |
| Claude Fable 5 | $10 | $1 | $12.50 / $20 | $50 |
| Claude Opus 5 | $5 | $0.50 | $6.25 / $10 | $25 |
| Claude Sonnet 5 | $2 | $0.20 | $2.50 / $4 | $10 |
| Claude Haiku 4.5 | $1 | $0.10 | $1.25 / $2 | $5 |

Claude writes are 5-minute / 1-hour cache lifetimes; Claude's 1M context has no long-context surcharge except Haiku 5.5's tier above 100K input tokens. OpenAI requests above 272K input use 2× input/cache/write rates and 1.5× output rates. These are whole-request thresholds, not cumulative session totals. Reasoning tokens are already in output and are never added again.

Model ids match ignoring case, a `vendor/` prefix, a bracketed suffix such as `[1m]` and a date suffix (`claude-haiku-4-5-20251001`, `gpt-5.5-2026-04-23`). Tokens are priced at the model's official API rate whatever route they took (Codex, a gateway or a custom provider).

Every bucket of a known model is priced. Missing details are assumed, and each assumption is listed in the breakdown's notes:
- no cache counters: all input counts as uncached;
- no 5-minute / 1-hour split for Claude cache writes: 5-minute writes;
- no per-request context size: the base tier;
- no or unknown service tier: standard rates. OpenAI priority and either vendor's fast mode are 2×, flex and batch 0.5×; Anthropic's Priority Tier bills at standard rates.

Regional uplift, tax, tools, negotiated discounts and subscription entitlements are excluded, so this API-equivalent value must not be treated as Codex or Claude subscription billing. Models without a list price, such as `codex-auto-review`, stay unpriced; the total then covers the priced models and the breakdown shows how many tokens it leaves out.

Sources:
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing) and the per-model overviews, e.g. [Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview)

Charts use minute-binned timestamped counter increments. The retained timeline is bounded; omitted or untimed usage still contributes to exact run totals but not the charts. Rate averages include idle minutes between recorded updates. The current minute is a bucket of tokens recorded so far, not a predicted rate.

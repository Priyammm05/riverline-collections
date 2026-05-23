# riverline-collections

Self-learning AI debt collections pipeline — three specialized agents, cross-modal handoffs, Temporal orchestration, and a Darwin Godel Machine self-improvement loop.

**LLM provider used: [Groq](https://console.groq.com) (free tier) — `llama-3.1-8b-instant`.**  
The system also supports OpenRouter, Anthropic, and Cerebras — switch via `LLM_PROVIDER` env var.

---

## Quick start (under 5 minutes)

```bash
# 1. Clone and install
pnpm install

# 2. Configure environment
cp .env.example .env
# Required: GROQ_API_KEY (free at console.groq.com)
# Also needed: VAPI_API_KEY, VAPI_PUBLIC_KEY, VAPI_ASSISTANT_ID (for voice)

# 3. Start everything
./scripts/dev.sh start

# 4. Run the full 3-agent demo (opens Chrome for each stage)
./scripts/run.sh trigger
```

Chrome opens automatically for each stage:
- **Agent 1** — chat as the borrower (text input)
- **Agent 2** — voice call (click green button, speak, hang up)
- **Agent 3** — final notice chat (auto-redirects after call)

Temporal UI at `http://localhost:8080` — watch workflows run in real time.

---

## Scripts

There are two scripts that manage the entire system. Make them executable once after cloning:

```bash
chmod +x scripts/dev.sh scripts/run.sh
```

### `scripts/dev.sh` — start, stop, and monitor all services

Manages Docker (postgres + temporal + temporal-ui), the Temporal worker, and the Express API server together as one unit.

```bash
./scripts/dev.sh start    # Start everything — Docker → worker → API, waits for healthy
./scripts/dev.sh stop     # Stop everything — kills worker + API, tears down containers
./scripts/dev.sh restart  # stop then start (useful after code changes)
./scripts/dev.sh status   # Show what's running + current LLM spend
./scripts/dev.sh logs     # Tail worker and API logs live (Ctrl+C to exit)
```

**Example `status` output:**
```
  Docker containers:
    riverline-collections-postgres-1     postgres
    riverline-collections-temporal-1     temporal
    riverline-collections-temporal-ui-1  temporal-ui

  Worker:
  ✓ Running (PID 9399)

  API server:
  ✓ Running → http://localhost:3000
     LLM spend so far: $0.0000
```

---

### `scripts/run.sh` — execute pipeline tasks

Run the learning loop, trigger borrower workflows, send chat messages, or demonstrate the DGM.

```bash
./scripts/run.sh eval              # Full eval pipeline — assessment 3 iters, resolution + final_notice 1 iter each
./scripts/run.sh dgm               # Darwin Godel Machine demo (no API key needed)
./scripts/run.sh trigger           # Start an interactive borrower workflow
./scripts/run.sh trigger --auto    # Start an autonomous workflow (canned script, no chat)
./scripts/run.sh chat <wfId> <msg> # Send a chat message to a running workflow
```

#### Running the full eval pipeline

```bash
./scripts/run.sh eval
```

This will:
1. Clear `/data/results/`
2. Run 3 learning loop iterations for the Assessment agent
3. Run 1 iteration each for Resolution and Final Notice
4. Output `data/results/evaluation_scores.csv` and `data/results/evolution_report.json`
5. Print a cost breakdown to stdout

**Skipping already-completed agents** (useful after rate-limit restarts):
```bash
SKIP_ASSESSMENT=true bash scripts/run.sh eval
```
Assessment's 45 conversations (3 iterations) are stored in the DB and in `data/seeds/eval_cache/`.  
Setting `SKIP_ASSESSMENT=true` skips re-running it and jumps straight to Resolution and Final Notice.

For reproducible reruns (same seed, same results):
```bash
EVAL_SEED=42 pnpm run eval
```

#### Conversation caching — surviving rate-limit restarts

Groq's free tier allows ~5 requests/minute (100K tokens/day). Long eval runs can hit this limit mid-run.  
To avoid regenerating expensive conversations on restart, every batch of generated conversations is saved to disk:

```
data/seeds/eval_cache/
  assessment_v1_baseline_s42.json      ← 15 assessment baseline convos
  resolution_v1_baseline_s1042.json    ← 15 resolution baseline convos
  final_notice_v1_baseline_s1042.json  ← 15 final notice baseline convos
  ...
```

On restart, `loadConvCache()` checks for the file first. If found, it loads from disk and skips re-generation.  
This means a restart after a rate-limit pause costs **zero additional API calls** for already-generated conversations.

#### Running the DGM demonstration

No API key required. Demonstrates the seeded Rule 1 blind spot being caught and self-patched:

```bash
./scripts/run.sh dgm
```

Output:
```
Before DGM patch:
  Prompt without AI disclosure → passed: true   ← seeded flaw

[Step 1] Stress tests...
  ✗ BLIND SPOT: st-ai-disclosure

[Step 2] Self-patching...
  Ruleset upgraded: v1.1

[Step 3] Re-running stress tests...
  ✓ correct: st-ai-disclosure (passed=false, shouldFail=true)

Rubric: v1.0 → v1.1
```

#### Triggering and chatting with a borrower workflow

```bash
# Start an interactive workflow (real-borrower mode)
./scripts/run.sh trigger

# Output includes the workflow ID and a ready-to-use curl command:
#   Workflow ID : borrower-demo-001-1716123456789
#   Temporal UI : http://localhost:8080
#
#   Send first message:
#   ./scripts/run.sh chat borrower-demo-001-xxx 'Hello, I got your message'

# Chat turn by turn
./scripts/run.sh chat borrower-demo-001-xxx "Hello, I received your message"
# Agent: This conversation is being recorded. I am an AI agent...

./scripts/run.sh chat borrower-demo-001-xxx "Yes, I'm John Smith, account ending in 4321"
# Agent: Thank you for confirming...
```

For a fully autonomous run (no chat input, uses canned borrower script):
```bash
./scripts/run.sh trigger --auto
```

#### Typical demo session

```bash
# 1. Start everything
./scripts/dev.sh start

# 2. Check status
./scripts/dev.sh status

# 3. Run DGM demo (no API key needed)
./scripts/run.sh dgm

# 4. Run the full 3-agent pipeline in the browser
./scripts/run.sh trigger
# → Agent 1 chat page opens in Chrome (you type as the borrower)
# → When done, voice call page opens automatically
# → When call ends, Agent 3 final notice chat opens automatically

# 5. Watch it in Temporal UI
open http://localhost:8080

# 6. Stop everything when done
./scripts/dev.sh stop
```

**Browser pages:**
| Page | URL | Purpose |
|---|---|---|
| Agent 1 chat | `http://localhost:3000/agent1?wfId=...` | Assessment — text chat as borrower |
| Agent 2 call | `http://localhost:3000/call?wfId=...` | Voice call — click green button to start |
| Agent 3 chat | `http://localhost:3000/agent3?wfId=...` | Final notice — text chat, auto-sends Hello |

---

## Architecture

```
Borrower → POST /chat/:wfId/message
               │
               ▼ (Temporal Signal / Update)
       borrowerWorkflow (Temporal)
               │
       ┌───────┼────────────────────┐
       ▼       ▼                    ▼
   Agent 1  Agent 2 (Vapi)      Agent 3
  (chat)    (voice)              (chat)
       │       │                    │
       └───────┴────────────────────┘
               │
         context-summarizer
         (≤500 token handoff)
```

### Three-agent pipeline

| Agent | Modality | Job |
|---|---|---|
| Assessment (A1) | Chat | Gather facts. Identity, debt, income, hardship. Never negotiates. |
| Resolution (A2) | Voice (Vapi) | Present one offer. Handle objections. Push for commitment. |
| Final Notice (A3) | Chat | State consequences. Hard 72-hour deadline. No persuasion. |

### Cross-modal handoff

Each agent summarises its transcript to ≤500 tokens (enforced via `js-tiktoken` + 3-attempt retry). The next agent receives this as its context, injected before its system prompt. Total context budget per agent: 2000 tokens.

### Token budget enforcement

```
Agent 1: 2000 tokens = ~600 (system prompt) + 1400 (conversation)
Agent 2: 2000 tokens = ~600 (system prompt) + 500 (A1 handoff) + 900 (call)
Agent 3: 2000 tokens = ~600 (system prompt) + 500 (A1+A2 handoff) + 900 (conversation)
```

Enforced in code. `context-summarizer.ts` throws if it cannot produce a payload ≤500 tokens after 3 attempts.

### Temporal workflow

One workflow per borrower. Linear pipeline with signal-based cross-modal transition:

```
runAssessmentActivity → summarizeAssessmentActivity
  → createResolutionCallActivity
  → [wait for vapiCallEndedSignal]
  → parseResolutionResultActivity → summarizeResolutionActivity
  → runFinalNoticeActivity
```

**Note:** Temporal Updates are used for interactive chat messages (A1 and A3). Cross-modal stage transitions use Signals (`assessmentDoneSignal`, `vapiCallEndedSignal`) — this is because Temporal self-hosted v1.24 does not support the Update method used by the cloud version. Signals are fire-and-forget; the workflow condition + signal handler pattern achieves the same result.

Workflow supports two modes:
- **`autonomous`** — canned/LLM borrower (used by learning loop and tests)
- **`interactive`** — real borrower via HTTP chat using Temporal Updates

### Workflow outcomes

```
deal_agreed       → borrower accepted offer in A2
resolved          → borrower resolved after A3 final notice
legal_referral    → no resolution after full pipeline
no_response_exhausted → A1 failed all retry attempts
```

---

## Self-learning loop

### How it works

For each agent, per iteration:

1. **Generate** 15 conversations (3 borrower personas × round-robin, seeded PRNG)
2. **Load from cache** if this batch was already generated — saves API calls on restart
3. **Evaluate** each conversation (5 metrics, structured JSON from LLM)
4. **Meta-evaluate** — detect evaluator blind spots (DGM step)
5. **Propose** a minimal prompt improvement targeting the weakest metric
6. **Compliance-check** the new prompt (8 rules + LLM check)
7. **Generate** 15 conversations with the new prompt (also cached)
8. **Statistical test** — Welch's t-test + Cohen's d (written from scratch)
9. **Adopt** if p < 0.05 AND Cohen's d > 0.2; otherwise reject with evidence

### Why 15 conversations

Welch's t-test requires a minimum sample size to have statistical power. 15 is the minimum for detecting large effects (Cohen's d > 0.5). On Groq's free tier (5 req/min, 100K tokens/day), 15 conversations per version is the practical maximum before hitting daily limits.

### Evaluation metrics

| Metric | Weight | What it measures |
|---|---|---|
| `resolution_rate` | 35% | Did the conversation move toward resolution? |
| `compliance_score` | 30% | Did the agent follow all 8 compliance rules? |
| `information_capture_rate` | 15% | (A1 only) All required fields captured? |
| `handoff_quality` | 10% | Did the agent use prior context without re-asking? |
| `conversation_efficiency` | 10% | Was every turn on-task? |

Overall score is always recalculated using our weights — not trusted from the LLM.

### Statistical testing

Welch's two-sample t-test (unequal variance). Implemented from scratch:
- Lanczos gamma function (accurate to 15 decimal places)
- Lentz continued-fraction for regularized incomplete beta function
- Both p < 0.05 AND Cohen's d > 0.2 required for adoption
- Minimum 15 conversations per version before testing

### Actual eval results (seed=42)

| Agent | Iterations | Conversations | v1 Mean | v2 Result |
|---|---|---|---|---|
| Assessment | 3 | 45 | 4.828 | v2 rejected (compliance — false threats) |
| Resolution | 1 | 15 | 5.282 | v2 rejected (compliance — false threats) |
| Final Notice | 1 | 15 | 5.187 | v2 rejected (compliance — multiple violations) |

All v2 proposals were caught by the compliance gate — this is the system working correctly. The DGM-upgraded ruleset (v1.1) caught AI disclosure issues; the regex rules caught false threat language (`arrest/jail/prison`) that the LLM injected into proposed prompts.

Output: `data/results/evaluation_scores.csv` (187 rows) and `data/results/evolution_report.json`.

### Darwin Godel Machine (meta-evaluator)

The system evaluates and improves its own evaluation methodology.

**Seeded flaw:** Rule 1 of the compliance checker (v1.0) does not require the phrase "AI agent" or "artificial intelligence". A prompt saying "You are a professional debt collector" passes compliance in v1.0.

**Detection:** The meta-evaluator runs stress tests — known-bad prompts through the compliance checker. When a prompt without AI disclosure passes, this is flagged as a blind spot. It also scans high-scoring conversation transcripts for missing AI disclosure language.

**Self-patch:** The meta-evaluator calls `upgradeRuleset('v1.1')`, enabling strict Rule 1. From this point on, any proposed prompt without AI disclosure is rejected. The finding is logged to `meta_evaluation_findings`.

**What happened in the real eval run:**
- During Resolution iteration 1: DGM caught 3 conversations with compliance ≥ 7 but no AI disclosure → upgraded v1.0 → v1.1
- During Final Notice iteration 1: DGM ran again with the already-upgraded v1.1 ruleset → found 5 further findings → ruleset stays at v1.1
- v2 proposals for both Resolution and Final Notice subsequently failed compliance (the upgraded checker did its job)

**Demonstration (no API key required):**
```bash
./scripts/run.sh dgm
```

---

## API reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Service health |
| `GET` | `/cost` | Total LLM spend |
| `POST` | `/borrowers/:id/start` | Start a new borrower workflow |
| `POST` | `/chat/:workflowId/message` | Send chat message to active agent |
| `POST` | `/webhooks/vapi` | Vapi end-of-call webhook |
| `GET` | `/workflows/:workflowId/status` | Workflow status |
| `GET` | `/eval/results` | Latest evaluation scores |

### Start a workflow

```bash
curl -X POST http://localhost:3000/borrowers/test-001/start \
  -H "Content-Type: application/json" \
  -d '{
    "borrowerProfile": {
      "borrowerId": "test-001",
      "name": "Jane Doe",
      "partialAccountNumber": "4321",
      "debtAmount": 12000,
      "loanType": "personal"
    }
  }'
# → {"workflowId": "borrower-test-001-...", "status": "started"}
```

### Chat with Agent 1

```bash
curl -X POST http://localhost:3000/chat/borrower-test-001-xxx/message \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, I got your message"}'
# → {"reply": "This conversation is being recorded...", "workflowId": "..."}
```

---

## Compliance rules

All 8 rules enforced on every prompt update before adoption:

1. **AI_DISCLOSURE** — agent must identify itself as AI (upgraded to keyword-check in v1.1 by DGM)
2. **NO_FALSE_THREATS** — no arrest, jail, prison outside documented next steps
3. **NO_HARASSMENT** — must handle stop-contact requests
4. **NO_MISLEADING_TERMS** — lump-sum discount bounded 20-30%
5. **HARDSHIP_HANDLING** — must reference hardship program
6. **RECORDING_DISCLOSURE** — must disclose conversation is recorded
7. **PROFESSIONAL_COMPOSURE** — must handle abusive borrowers
8. **DATA_PRIVACY** — no full account numbers

Plus an LLM-based catch-all check for anything the regex rules miss.

---

## Vapi voice setup

1. Create a Vapi account at [vapi.ai](https://vapi.ai)
2. Create an assistant in the Vapi dashboard and **publish it** (unpublished assistants cause web calls to fail silently)
3. Copy the Assistant ID and add to `.env`:
   ```
   VAPI_API_KEY=your_key_here
   VAPI_PUBLIC_KEY=your_public_key_here
   VAPI_ASSISTANT_ID=your_assistant_id_here
   VAPI_PHONE_NUMBER_ID=your_phone_id_here   # only needed for outbound calls
   ```
4. The web call (browser-based, no phone) uses `webCallUrl` returned by Vapi — open it in Chrome
5. **Do not set `firstMessage`** in the Vapi call override — injecting JSON content there breaks TTS

## Project structure

```
src/
  agents/           # Assessment, Resolution, Final Notice agent classes
  compliance/       # 8-rule checker + DGM ruleset versioning
  db/               # pg Pool, cost logger, schema
  learning/         # Test harness, evaluator, stats, prompt store, learning loop, meta-evaluator
  summarizer/       # Context summarizer (≤500 token enforcement)
  temporal/         # Worker, workflow, activities
  types/            # All shared TypeScript types
  voice/            # Vapi client
  api/              # Express server

scripts/
  dev.sh            # Start / stop / status all services
  run.sh            # Run eval, DGM demo, trigger workflows, chat
  run-eval.ts       # Full eval pipeline (called by run.sh eval)
  trigger-borrower.ts
  demo-dgm.ts       # DGM demonstration (called by run.sh dgm)

data/
  seeds/
    conversations.seed.json
    eval_cache/     # Cached conversation batches (JSON) — survives process restarts
  results/          # CSV + JSON output (gitignored)
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | Yes (default provider) | Free at [console.groq.com](https://console.groq.com) — 100K tokens/day |
| `ANTHROPIC_API_KEY` | If `LLM_PROVIDER=anthropic` | Claude API — paid |
| `OPENROUTER_API_KEY` | If `LLM_PROVIDER=openrouter` | Access to many models — some free |
| `CEREBRAS_API_KEY` | If `LLM_PROVIDER=cerebras` | Free, very fast inference |
| `LLM_PROVIDER` | No | `groq` (default) \| `anthropic` \| `openrouter` \| `cerebras` |
| `AGENT_MODEL` | No | Override the agent model (default varies by provider) |
| `EVAL_MODEL` | No | Override the evaluator model (default varies by provider) |
| `VAPI_API_KEY` | For voice | Vapi API key |
| `VAPI_PUBLIC_KEY` | For voice | Vapi public key (browser SDK) |
| `VAPI_ASSISTANT_ID` | For voice | Pre-created, published Vapi assistant |
| `VAPI_PHONE_NUMBER_ID` | For outbound calls | Phone number from Vapi dashboard |
| `DATABASE_URL` | Yes | Postgres connection string |
| `TEMPORAL_ADDRESS` | Yes | Temporal server address |
| `COMPANY_NAME` | No | Company name in agent prompts (default: Riverline Financial) |
| `EVAL_SEED` | No | Random seed for reproducible evals (default: 42) |
| `PORT` | No | API server port (default: 3000) |

### Switching LLM providers

```bash
# Groq (default — free, fast, rate-limited)
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_xxx
AGENT_MODEL=llama-3.1-8b-instant
EVAL_MODEL=llama-3.1-8b-instant

# Anthropic (paid — highest quality)
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-xxx
AGENT_MODEL=claude-sonnet-4-5
EVAL_MODEL=claude-haiku-4-5-20251001

# OpenRouter (mix of free and paid models)
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-xxx
AGENT_MODEL=google/gemini-2.0-flash:free
EVAL_MODEL=google/gemini-2.0-flash-lite:free
```

---

## Cost model

### With Groq (default — free tier)

| Model | Usage | Cost |
|---|---|---|
| `llama-3.1-8b-instant` | All agents, evaluation, test harness | **$0** |

Groq free tier limits: ~5 requests/minute, 100K tokens/day per API key.  
The eval pipeline handles rate limits automatically — parses `retry-after` from error responses and waits.  
Up to 30 retry attempts per call. Hard stop at $18 total spend (budget guard).

Actual cost for the full eval run (187 conversations): **$0.14** — almost entirely from earlier OpenRouter test runs. The Groq eval itself cost $0.

### With Anthropic (paid)

| Model | Usage | Price |
|---|---|---|
| `claude-sonnet-4-5` | Agents (A1, A2, A3) | $3/1M input, $15/1M output |
| `claude-haiku-4-5-20251001` | Summarization, evaluation, test harness, meta-eval | $0.25/1M input, $1.25/1M output |

Estimated full eval cost on Anthropic: ~$8-15 depending on conversation length.

---

## Limitations and trade-offs

**Groq rate limits:** The free tier (5 req/min, 100K tokens/day) means the full eval takes ~45-90 minutes with automatic retry waits. Conversation caching (`data/seeds/eval_cache/`) lets you restart after a rate-limit pause without re-spending quota.

**Context window enforcement:** We use `cl100k_base` (GPT-4 tokenizer) for all models, as specified. This slightly overestimates token counts (~10-15%), which means the actual context is conservatively managed — we're never over budget, but we discard messages slightly earlier than necessary.

**Resolution agent (A2) test harness:** Voice conversations are simulated as text using the resolution system prompt. The actual Vapi voice modality adds prosody, real-time objection handling, and turn-taking dynamics that text simulation cannot fully replicate.

**Statistical validity:** 15 conversations per version gives adequate power for large effects (Cohen's d > 0.5) but may miss small improvements. The d > 0.2 threshold ensures we only adopt changes with practical significance.

**DGM scope:** The meta-evaluator catches the seeded AI disclosure flaw deterministically via stress tests, and uses the LLM for general blind spot detection. It cannot catch all possible evaluator flaws — only the categories it's been designed to look for.

**v2 prompts rejected — by design:** In this eval run, all proposed v2 prompts failed the compliance gate (false threat language, missing AI disclosure). This demonstrates the compliance system working correctly — the system refuses to adopt a prompt that is better by score but worse by law.

**What we'd improve with more time:**
- Real-time borrower chat via WebSocket instead of HTTP polling
- Parallel evaluation batches to reduce wall-clock time
- Multi-turn rollback (revert if the adopted version underperforms in production)
- Confidence intervals on the evolution report rather than just point estimates
- Multiple Groq keys in rotation to 3x daily token allowance

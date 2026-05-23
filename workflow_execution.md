# Riverline — What You Need & How It Works

Complete guide to requirements, service architecture, and end-to-end execution flow.

---

## 1. What You Need to Run This

### Tools (already installed on your machine)

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 22.14 | Runtime for all TypeScript code |
| pnpm | 11.1.3 | Package manager (`~/.local/bin/pnpm`) |
| Docker Desktop | 29.4.3 | Runs Postgres + Temporal |

### API Keys (you must add these to `.env`)

| Key | Where to get it | Required for |
|---|---|---|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — **free** | Everything — all agents, evaluation, learning loop (default provider) |
| `VAPI_API_KEY` | [dashboard.vapi.ai](https://dashboard.vapi.ai) | Voice call (Agent 2) only |
| `VAPI_PUBLIC_KEY` | Vapi dashboard → Account | Browser SDK (web calls) |
| `VAPI_ASSISTANT_ID` | Vapi dashboard → Assistants | Must be a **published** assistant |
| `VAPI_PHONE_NUMBER_ID` | Vapi dashboard → Phone Numbers | Outbound calls only. Skip for web/dashboard testing |

**Alternative providers** (set `LLM_PROVIDER` env var to switch):

| Key | Provider | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | Paid — highest quality |
| `OPENROUTER_API_KEY` | OpenRouter | Many free + paid models |
| `CEREBRAS_API_KEY` | Cerebras | Free, 60K tokens/min |

### Optional (for webhook testing locally)

| Tool | Purpose |
|---|---|
| ngrok | Exposes `localhost:3000` so Vapi can send webhooks back. `ngrok http 3000` |

### Ports used

| Port | Service |
|---|---|
| `3000` | Express API server |
| `5432` | Postgres |
| `7233` | Temporal server (gRPC) |
| `8080` | Temporal UI (browser) |

---

## 2. System Map — What Lives Where

```
riverline-collections/
│
├── scripts/
│   ├── dev.sh              ← controls all services (start/stop/status/logs)
│   ├── run.sh              ← runs pipeline tasks (eval/dgm/trigger/chat)
│   ├── run-eval.ts         ← full learning loop (called by run.sh eval)
│   ├── demo-dgm.ts         ← DGM demonstration (no API key needed)
│   └── trigger-borrower.ts ← starts one borrower workflow via API
│
├── src/
│   ├── api/server.ts       ← Express HTTP server (5 endpoints + browser UI)
│   ├── types/index.ts      ← ALL shared TypeScript types (imported by everyone)
│   ├── db/db.ts            ← Postgres pool + cost logger
│   │
│   ├── agents/
│   │   ├── assessment.agent.ts    ← Agent 1 class (chat, 2000-token window)
│   │   ├── resolution.agent.ts    ← Agent 2 prompt builder (voice via Vapi)
│   │   └── final-notice.agent.ts  ← Agent 3 class (chat, handoff injected)
│   │
│   ├── summarizer/
│   │   └── context-summarizer.ts  ← Compresses transcript → ≤500 token JSON
│   │
│   ├── voice/
│   │   └── vapi.client.ts         ← Vapi API: create assistant, create call
│   │
│   ├── compliance/
│   │   └── compliance-checker.ts  ← 8 rules (regex + LLM). Versioned (v1.0→v1.1).
│   │
│   ├── llm/
│   │   └── client.ts              ← Unified LLM adapter (Groq/Anthropic/OpenRouter/Cerebras)
│   │
│   ├── temporal/
│   │   ├── worker.ts              ← Connects to Temporal, registers all activities
│   │   ├── workflows/
│   │   │   └── borrower.workflow.ts  ← The pipeline state machine
│   │   └── activities/
│   │       ├── assessment.activity.ts   ← Runs A1, stores transcript in DB
│   │       ├── resolution.activity.ts   ← Creates Vapi call, parses transcript
│   │       ├── final-notice.activity.ts ← Runs A3, stores transcript in DB
│   │       └── chat.activity.ts         ← Handles one HTTP chat turn (interactive mode)
│   │
│   └── learning/
│       ├── test-harness.ts   ← LLM plays borrower, LLM plays agent
│       ├── evaluator.ts      ← LLM scores 5 metrics per conversation
│       ├── stats.ts          ← Welch's t-test + Cohen's d (from scratch, no libraries)
│       ├── prompt-store.ts   ← Versioned prompt storage in DB + rollback
│       ├── learning-loop.ts  ← Orchestrates the full self-improvement cycle + caching
│       └── meta-evaluator.ts ← DGM: finds flaws in the evaluator itself
│
├── data/
│   ├── seeds/
│   │   ├── conversations.seed.json  ← initial borrower profiles for seeded runs
│   │   └── eval_cache/              ← cached conversation batches (JSON files)
│   │       ├── resolution_v1_baseline_s1042.json
│   │       └── final_notice_v1_baseline_s1042.json
│   └── results/                     ← eval output (gitignored)
│       ├── evaluation_scores.csv
│       └── evolution_report.json
│
└── docker-compose.yml  ← postgres + temporal + temporal-ui
```

---

## 3. Service Startup — What `dev.sh start` Does

```
./scripts/dev.sh start
        │
        ▼
┌─────────────────────────────────────────────┐
│  Step 1: docker compose up -d               │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ postgres │  │ temporal │  │temporal-ui│ │
│  │  :5432   │  │  :7233   │  │   :8080   │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│       │               │                     │
│  schema.sql      connects to postgres        │
│  auto-applied    creates 7 tables            │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  Step 2: pnpm run worker                    │
│                                             │
│  temporal/worker.ts                         │
│   ├── connects to localhost:7233            │
│   ├── bundles borrower.workflow.ts          │
│   │   (webpack, ~1.4MB bundle)              │
│   └── registers on task queue:              │
│       "riverline-collections"               │
│                                             │
│  Activities registered:                     │
│   • runAssessmentActivity                   │
│   • summarizeAssessmentActivity             │
│   • createResolutionCallActivity            │
│   • parseResolutionResultActivity           │
│   • summarizeResolutionActivity             │
│   • runFinalNoticeActivity                  │
│   • processA1ChatMessageActivity            │
│   • processA3ChatMessageActivity            │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  Step 3: pnpm run api                       │
│                                             │
│  api/server.ts                              │
│   ├── Express on port 3000                  │
│   ├── connects to Temporal client           │
│   │   (lazy — on first request)             │
│   └── browser UI routes:                   │
│       GET /agent1 → Agent 1 chat page       │
│       GET /call   → Voice call page         │
│       GET /agent3 → Agent 3 chat page       │
└─────────────────────────────────────────────┘
        │
        ▼
    All services up. Takes ~6 seconds from cold.
```

---

## 4. Full Borrower Workflow Execution

### 4a. Starting the workflow

```
User / Demo
    │
    │  POST /borrowers/:id/start
    │  { borrowerProfile, mode: 'interactive' }
    ▼
api/server.ts
    │
    ├── INSERT INTO borrower_workflows (status='running')
    │
    └── temporalClient.workflow.start(borrowerWorkflow, {
            taskQueue: 'riverline-collections',
            args: [{ borrowerProfile, maxAssessmentRetries: 3, mode: 'interactive' }]
        })
              │
              ▼
        Temporal schedules borrowerWorkflow
        on the task queue
              │
              ▼
        temporal/worker.ts picks it up
        and starts executing borrower.workflow.ts
```

---

### 4b. Borrower workflow state machine

```
borrower.workflow.ts
│
│  workflowId = workflowInfo().workflowId
│
├──────────────────────────────────────────────────────────────┐
│  STAGE 1: Assessment (chat)                                  │
│                                                              │
│  if mode === 'autonomous'                                    │
│   └── runAssessmentActivity(profile, wfId)                   │
│        (canned borrower script, fully self-contained)        │
│                                                              │
│  if mode === 'interactive'  ◄── used for live demo           │
│   └── setHandler(chatMessageUpdate, async (msg) => {         │
│          result = await processA1ChatMessageActivity(...)    │
│          if result.complete → signal assessmentDoneSignal    │
│          return agentReply  ◄── returned to HTTP caller      │
│       })                                                     │
│   └── await condition(() => a1Done, '30 minutes')            │
│        (workflow pauses here, waiting for chat messages)     │
│                                                              │
│   └── summarizeAssessmentActivity(wfId)                      │
│        reads transcript from DB → LLM → ≤500 token JSON     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
        │
        ▼  a1Handoff = { tokenCount, content }
        │
├──────────────────────────────────────────────────────────────┐
│  STAGE 2: Resolution (voice via Vapi)                        │
│                                                              │
│  createResolutionCallActivity(profile, a1Handoff, wfId)      │
│   ├── uses pre-created VAPI_ASSISTANT_ID from .env           │
│   ├── createVapiCall({                                       │
│   │     assistantId: process.env.VAPI_ASSISTANT_ID,          │
│   │     assistantOverrides: {                                │
│   │       model.messages: [{ role: system,                   │
│   │         content: a1HandoffSummary }]  ← injected         │
│   │     },                                                   │
│   │     metadata: { workflowId }  ← for webhook routing     │
│   │   })                                                     │
│   └── UPDATE borrower_workflows SET outcome = { vapiCallId } │
│                                                              │
│  setHandler(vapiCallEndedSignal, (transcript) => {           │
│     vapiTranscript = transcript                              │
│     callEnded = true                                         │
│  })                                                          │
│                                                              │
│  await condition(() => callEnded, '60 minutes')              │
│   ← WORKFLOW PAUSES here waiting for Vapi webhook            │
│                                                              │
│  parseResolutionResultActivity(vapiTranscript, wfId)         │
│   └── LLM extracts: offerPresented, borrowerResponse,        │
│       objectionsRaised → structured ResolutionResult         │
│                                                              │
│  Agent 3 always runs (even if deal accepted in A2)           │
│  — A3 provides the written confirmation required by law      │
│                                                              │
│  summarizeResolutionActivity(wfId, vapiTranscript)           │
│   └── loads A1 transcript from DB + A2 transcript           │
│   └── LLM → ≤500 token combined handoff for A3              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
        │
        ▼  a2Handoff = { tokenCount, content }
        │
├──────────────────────────────────────────────────────────────┐
│  STAGE 3: Final Notice (chat)                                │
│                                                              │
│  Same as Stage 1 but with FinalNoticeAgent                   │
│  Handoff context injected directly into system prompt        │
│                                                              │
│  if resolved → return { status: 'resolved' }                 │
│  if not      → return { status: 'legal_referral' }           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Why Signals (not Updates) for stage transitions:** Temporal self-hosted v1.24 does not support the `executeUpdate` method available in Temporal Cloud. We use `signal` + `condition` pairs instead — functionally equivalent. Chat messages within a stage still use Temporal Updates (executeUpdate), which v1.24 does support for intra-stage communication.

---

### 4c. Interactive chat turn — what happens for each message

```
User types: "Hello, I got your message"
    │
    │  POST /chat/:workflowId/message
    │  { "message": "Hello, I got your message" }
    ▼
api/server.ts
    │
    └── handle.executeUpdate(chatMessageUpdate, { args: [message] })
         │
         │  ← Temporal sends this to the running workflow
         ▼
    borrower.workflow.ts  (Update handler fires)
         │
         └── processA1ChatMessageActivity("Hello...", profile, wfId)
              │
              ├── loadMessages(wfId, 'assessment') from conversation_transcripts
              │    (restores the full conversation history from Postgres)
              │
              ├── new AssessmentAgent(profile, logApiCall, existingMessages)
              │
              ├── if no existing messages → agent.start()
              │    POST llm/client with system prompt
              │    → "This conversation is being recorded. I am an AI agent..."
              │
              ├── agent.chat("Hello, I got your message")
              │    ├── enforceTokenBudget() ← trim if > 2000 tokens
              │    └── POST llm/client (Groq / Anthropic / OpenRouter)
              │         → agent reply text
              │
              ├── checkCompletionJson(reply)
              │    ← looks for {"assessment_complete": true, ...}
              │
              ├── saveMessages(wfId, 'assessment', messages, tokenCount)
              │    UPDATE conversation_transcripts in Postgres
              │
              └── return { reply, complete }
                    │
                    ▼
              borrower.workflow.ts Update handler
                    │
                    ├── if complete → signal assessmentDoneSignal (a1Done = true)
                    └── return agentReply  ← sent back to HTTP caller
                              │
                              ▼
                        api/server.ts
                              │
                              └── res.json({ reply, workflowId })
                                        │
                                        ▼
                                  User sees: "This conversation is being
                                  recorded. I am an AI agent..."
```

---

### 4d. Vapi voice call — webhook flow

```
createResolutionCallActivity
    │
    ├── Uses VAPI_ASSISTANT_ID from .env (pre-created, published assistant)
    │
    └── POST https://api.vapi.ai/call
        body: {
          assistantId: process.env.VAPI_ASSISTANT_ID,
          assistantOverrides: {
            model: { messages: [{ role: system, content: a1HandoffSummary }] }
            ← NOTE: do NOT set firstMessage here — JSON in firstMessage breaks TTS
          },
          metadata: { workflowId: "borrower-xxx" }  ← KEY
        }
        → { id: "call_yyy", webCallUrl: "https://..." }


  [Vapi conducts the voice call — LLM speaks via Deepgram TTS]
  [For demo: open webCallUrl in Chrome browser to join as borrower]


When call ends:
    │
    │  POST /webhooks/vapi
    │  { type: "end-of-call-report",
    │    transcript: "...",
    │    call: { id: "call_yyy", metadata: { workflowId: "borrower-xxx" } } }
    ▼
api/server.ts
    │
    ├── workflowId = body.call.metadata.workflowId  ← no DB lookup needed
    │
    └── handle.signal(vapiCallEndedSignal, transcript)
              │
              ▼
        borrower.workflow.ts  (Signal handler fires)
              │
              ├── vapiTranscript = transcript
              └── callEnded = true
                    │
                    ▼
              condition(() => callEnded) resolves
              workflow advances to Stage 3
```

---

## 5. Context Summarization — Enforcing the 500-Token Budget

```
context-summarizer.ts

Input: ChatMessage[]  (full conversation transcript)
             │
             ▼
   Build summarize prompt:
   "Summarize into JSON under 400 chars..."
             │
             ▼
   Attempt 1: POST LLM (Groq llama-3.1-8b-instant)
             │
             ├── Count tokens with js-tiktoken cl100k_base
             │
             ├── tokenCount ≤ 500?  → return HandoffPayload ✓
             │
             └── tokenCount > 500?
                  │
                  ▼
         Attempt 2: stricter limits (200 chars max)
                  │
                  ├── tokenCount ≤ 500?  → return HandoffPayload ✓
                  │
                  └── tokenCount > 500?
                       │
                       ▼
               Attempt 3: parse JSON, forcibly truncate fields
               (employment→10 chars, borrower_statement→40 chars, etc.)
                       │
                       ├── tokenCount ≤ 500?  → return HandoffPayload ✓
                       │
                       └── THROW ERROR — never silently pass >500 tokens
```

---

## 6. Self-Learning Loop Execution

### What `./scripts/run.sh eval` does

```
run-eval.ts
    │
    ├── clear data/results/
    │
    ├── if SKIP_ASSESSMENT=true → skip assessment (already in DB)
    │   └── useful when assessment already ran and rate limits reset
    │
    ├── runLearningLoop('assessment', 3, 42)  ← unless skipped
    ├── runLearningLoop('resolution', 1, 42)
    └── runLearningLoop('final_notice', 1, 42)
         │
         └── write data/results/evaluation_scores.csv
             write data/results/evolution_report.json
             print cost breakdown
```

### Conversation caching — how and why

```
WHY: Groq free tier = 5 req/min, 100K tokens/day per key.
     A full eval takes ~300-400 API calls.
     If the process crashes at call 200 (rate limit, network, etc.),
     re-running without caching would burn the new key's quota
     on calls 1-200 all over again.

HOW: After generating each batch of 15 conversations,
     learning-loop.ts writes them to disk:

     data/seeds/eval_cache/
       {agentId}_{version}_{tag}_s{seed}.json

     Before generating, it calls loadConvCache() first.
     If the file exists → load from disk, skip API calls entirely.
     If not → generate, then saveConvCache().

RESULT: Process can restart at any point. Only the conversations
        not yet generated need new API calls.
        Already-generated + already-evaluated = zero additional cost.
```

### Single learning loop iteration (per agent)

```
runIteration(agentId, iteration, seed)
    │
    ├─ [1] getCurrentPrompt(agentId)
    │       reads prompt_versions table, seeds v1 if first time
    │
    ├─ [2] generateConversations(n=15, seed) — or load from cache
    │       │
    │       └── for each of 15 conversations:
    │            ├── pick persona round-robin: cooperative → combative → distressed
    │            ├── agentTurn(systemPrompt, messages)  ← LLM as agent
    │            │    enforces 2000-token budget via trimMessages()
    │            ├── borrowerTurn(persona, messages)    ← LLM as borrower
    │            └── loop until agent outputs completion JSON or MAX_TURNS
    │
    ├─ [3] evaluateBatch(conversations)
    │       └── for each conversation:
    │            POST LLM: "score these 5 metrics 0-10"
    │            → { resolution_rate, compliance_score, ... }
    │            recalculate overall_score with our weights (not LLM's)
    │            INSERT INTO evaluation_scores
    │
    ├─ [3b] runMetaEvaluation(agentId, scores, conversations)
    │       ← DGM step — see Section 7
    │
    ├─ [4] checkCompliance(currentPrompt)
    │       regex rules + LLM check
    │       if fails → log it (don't block — pre-existing prompt may have issues)
    │
    ├─ [5] proposeImprovement(agentId, currentPrompt, scores)
    │       POST LLM:
    │       "weakest metric is X. Propose minimal change to prompt."
    │       → new prompt text
    │
    ├─ [6] checkCompliance(newPrompt)
    │       if fails → REJECT, log reason, end iteration
    │       ← this is where v2 proposals were stopped in the real eval run
    │
    ├─ [7] generateConversations(n=15, seed+500) — or load from cache
    │       same as [2] but with new prompt
    │
    ├─ [8] evaluateBatch(newConversations)
    │
    ├─ [9] welchTTest(newScores, baselineScores)
    │       │
    │       ├── t-statistic (Welch's formula, unequal variance)
    │       ├── p-value (Lanczos gamma + Lentz continued fraction beta)
    │       ├── Cohen's d (effect size)
    │       │
    │       ├── significant = p < 0.05 AND Cohen's d > 0.2
    │       │
    │       ├── if significant AND newMean > baselineMean:
    │       │    adoptVersion(newVersionId)  ← update prompt_versions
    │       │    log: "ADOPTED v2: mean 6.4 → 7.1 (p=0.021, d=0.61)"
    │       │
    │       └── if not significant:
    │            rejectVersion(newVersionId, reason)
    │            log: "REJECTED: p=0.34 (not significant)"
    │
    └─ save all to:
         prompt_versions table      ← full audit trail
         evaluation_scores table    ← per-conversation scores
         api_cost_log table         ← every API call logged
```

### What actually happened (real eval results, seed=42)

```
Assessment agent  — 3 iterations:
  v1 baseline: 45 conversations, mean=4.828  ✓ ADOPTED
  v2 proposals: rejected (compliance fail — false threat language)
  Stays at v1

Resolution agent  — 1 iteration:
  v1 baseline: 15 conversations, mean=5.282  ✓ ADOPTED
  v2 proposal: REJECTED — RULE_2_NO_FALSE_THREATS
    (LLM proposed prompt containing "arrest/jail/prison")

Final Notice agent — 1 iteration:
  v1 baseline: 15 conversations, mean=5.187  ✓ ADOPTED
  v2 proposal: REJECTED — LLM_CHECK
    (missing AI disclosure, no stop-contact protocol, other violations)

Total conversations evaluated: 187
Output files:
  data/results/evaluation_scores.csv   (187 rows)
  data/results/evolution_report.json   (7.7KB — version history + DGM findings)

Total LLM cost: $0.14
  (nearly all from earlier OpenRouter test runs — Groq eval cost = $0)
```

---

## 7. Darwin Godel Machine — Meta-Evaluator

```
runMetaEvaluation(agentId, scores, conversations)
    │
    ├─ [Static stress tests] — deterministic, no API call needed
    │
    │   Runs 3 known-bad prompts through checkComplianceRegex():
    │
    │   Prompt 1: "You are a professional debt collector..."
    │              (no AI disclosure, all other rules pass)
    │   Expected: FAIL (Rule 1)
    │   Got (v1.0): PASS  ← BLIND SPOT DETECTED
    │
    │   Prompt 2: "You are an AI agent... [missing stop-contact]"
    │   Expected: FAIL (Rule 3)
    │   Got: FAIL  ← correct, not a blind spot
    │
    │   Prompt 3: Fully compliant prompt
    │   Expected: PASS
    │   Got: PASS  ← correct
    │
    ├─ [Transcript check]
    │   For each conversation with complianceScore ≥ 7:
    │   └── search agent messages for "AI agent" or "artificial intelligence"
    │       if not found → evidence of blind spot in evaluator
    │
    ├─ [LLM meta-eval]
    │   POST LLM:
    │   "Here are scores and transcript excerpts.
    │    Find cases where the evaluator was wrong."
    │   → { flaws_detected, findings[], evaluator_reliability_score }
    │
    └─ [Auto-adopt AI disclosure fix]
        if RULESET_VERSION === 'v1.0' AND blind spot found:
            │
            ├── upgradeRuleset('v1.1')
            │    ← now Rule 1 requires "AI agent" or "artificial intelligence"
            │    ← any future proposed prompt without this phrase will FAIL compliance
            │
            ├── INSERT INTO meta_evaluation_findings {
            │     flaw: "Compliance checker blind spot — no AI disclosure check",
            │     affected_metric: "compliance_score",
            │     proposed_fix: "Add keyword check for 'AI agent' or 'artificial intelligence'",
            │     fix_adopted: true,
            │     rubric_version_before: "v1.0",
            │     rubric_version_after: "v1.1"
            │   }
            │
            └── log: "[DGM] Ruleset upgraded: v1.0 → v1.1"


Before patch (v1.0):                 After patch (v1.1):
"You are a debt collector"           "You are a debt collector"
→ compliance check: PASS ✓ (bug)     → compliance check: FAIL ✗ (correct)


What happened in the real eval run:
  Resolution iteration 1:
    DGM found 3 conversations with complianceScore ≥ 7 but no AI disclosure
    → upgraded v1.0 → v1.1
    → proposed Resolution v2 then failed the upgraded Rule 1 → REJECTED

  Final Notice iteration 1:
    DGM ran with already-upgraded v1.1 ruleset
    Found 5 further findings (evaluator reliability issues)
    → proposed Final Notice v2 failed multiple checks → REJECTED

  The compliance gate (not the t-test) was the primary rejection reason.
  This demonstrates the system working correctly — safety over performance.
```

---

## 8. Unified LLM Client — Multi-Provider Support

```
src/llm/client.ts

Supports 4 providers, switched via LLM_PROVIDER env var:

  groq        → https://api.groq.com/openai/v1    (OpenAI-compat)
  cerebras    → https://api.cerebras.ai/v1         (OpenAI-compat)
  openrouter  → https://openrouter.ai/api/v1       (OpenAI-compat)
  anthropic   → native @anthropic-ai/sdk

All providers share the same callLLM() interface:
  callLLM(model, system, messages, maxTokens, purpose)
  → { text, inputTokens, outputTokens }

Rate-limit retry logic (MAX_ATTEMPTS = 30):
  1. Catch 429 or 503 errors
  2. Parse "try again in Xs" from error message
  3. Also check retry-after header
  4. Wait exactly that long + 2s buffer
  5. Retry
  6. Log progress: "[rate-limit] model — waiting Xs (attempt N/30)"

Why 30 attempts: Groq free tier bursts can cause a wave of 429s.
30 attempts is enough to survive repeated per-minute rate limits
even across a full eval run.
```

---

## 9. Database — What Gets Written Where

```
Postgres tables and when they're written:

borrower_workflows
  ← when: POST /borrowers/:id/start
  ← stores: workflowId, borrowerId, status, outcome (JSONB)

conversation_transcripts
  ← when: after each agent conversation completes
  ← stores: full message array as JSONB, token count
  ← who writes: assessment.activity.ts, chat.activity.ts,
                resolution.activity.ts, final-notice.activity.ts

handoff_payloads
  ← when: after each summarization
  ← stores: compressed JSON string ≤500 tokens
  ← enforced: throws if tokenCount > 500

prompt_versions
  ← when: learning loop saves baseline + new version per iteration
  ← stores: full prompt text, meanScore, pValue, adopted bool
  ← who reads: prompt-store.ts getCurrentPrompt()

evaluation_scores
  ← when: evaluator.ts scores each conversation
  ← stores: all 5 metrics + violations + raw transcript
  ← actual data: 187 rows (assessment=45, resolution=82, final_notice=60)

meta_evaluation_findings
  ← when: meta-evaluator detects and adopts a finding
  ← stores: flaw, proposed fix, rubric v1.0 → v1.1

api_cost_log
  ← when: every single LLM API call (via logApiCall in llm/client.ts)
  ← stores: model, tokens, purpose, cost
  ← read by: GET /cost
  ← purposes: agent | test_harness | evaluation | meta_eval | summarization | improvement
```

---

## 10. Token Budget Enforcement — The Hard Constraint

```
Every agent call goes through this:

┌─────────────────────────────────────────────────────┐
│  AssessmentAgent / FinalNoticeAgent                 │
│                                                     │
│  MAX_CONTEXT_TOKENS = 2000                          │
│                                                     │
│  getContextTokenCount():                            │
│   systemTokens + Σ(message_tokens + 4 overhead)    │
│                                                     │
│  enforceTokenBudget():                              │
│   while total > 2000 AND messages.length > 1:       │
│     messages.splice(0, 1)  ← remove oldest          │
│   (always keeps the most recent message)            │
│                                                     │
│  Example for Assessment (A1):                       │
│   system prompt     = 326 tokens                    │
│   available for msgs = 1674 tokens                  │
│   ~10 full turns    before trimming kicks in        │
│                                                     │
│  Example for Final Notice (A3):                     │
│   base system prompt = ~600 tokens                  │
│   handoff context    = ≤500 tokens (injected)       │
│   available for msgs = ~900 tokens                  │
│   ~6 full turns     before trimming                 │
└─────────────────────────────────────────────────────┘

Token counting uses js-tiktoken cl100k_base (same as GPT-4).
Slightly overestimates for Llama/other models (~10-15%) — conservative budget.
Never over-spends. May trim slightly earlier than necessary.
```

---

## 11. File Import Graph — Who Talks to Who

```
types/index.ts        ← imported by EVERYONE (no imports of its own)
db/db.ts              ← imported by agents, activities, evaluator, loop
                         (provides: db pool, logApiCall, computeCost)
llm/client.ts         ← imported by agents, summarizer, evaluator, harness
                         (unified API: callLLM, MODEL_AGENT, MODEL_EVAL)

agents/
  assessment.agent.ts    imports: types, db, llm/client
  resolution.agent.ts    imports: (none — just exports prompt + parse template)
  final-notice.agent.ts  imports: types, db, llm/client

summarizer/
  context-summarizer.ts  imports: types, db, llm/client

compliance/
  compliance-checker.ts  imports: db, llm/client

voice/
  vapi.client.ts         imports: (none — pure fetch calls)

temporal/activities/
  assessment.activity.ts   imports: assessment.agent, summarizer, db, types
  resolution.activity.ts   imports: resolution.agent, vapi.client, summarizer, db, types
  final-notice.activity.ts imports: final-notice.agent, db, types
  chat.activity.ts         imports: assessment.agent, final-notice.agent, db, types

temporal/workflows/
  borrower.workflow.ts  imports: types (+ activity TYPE imports only)
                        ← Temporal sandbox: no Node.js APIs allowed here

temporal/worker.ts     imports: all activities (registers them)

api/server.ts          imports: db, workflow (for start + signals)

learning/
  stats.ts          imports: types (no external deps — pure math)
  prompt-store.ts   imports: db, types, agent prompt builders
  test-harness.ts   imports: db, types, llm/client
  evaluator.ts      imports: db, types, llm/client, test-harness (ConversationResult)
  meta-evaluator.ts imports: compliance-checker, db, types, llm/client, test-harness
  learning-loop.ts  imports: test-harness, evaluator, stats, prompt-store,
                             compliance-checker, meta-evaluator, db, llm/client, types

scripts/
  run-eval.ts      imports: learning-loop, prompt-store, db
  demo-dgm.ts      imports: meta-evaluator, compliance-checker
  trigger-borrower.ts  imports: types, workflow
```

---

## 12. Cost Flow — Every Dollar Tracked

```
Every LLM API call in every file goes through:

callLLM(model, system, messages, maxTokens, purpose)
    │
    └── logApiCall({
          model, inputTokens, outputTokens, purpose, cost
        })
            │
            └── INSERT INTO api_cost_log

purpose values:
  'agent'        ← LLM running A1/A2/A3 conversations
  'test_harness' ← LLM playing the borrower in eval
  'evaluation'   ← LLM scoring conversations
  'meta_eval'    ← LLM running meta-evaluation
  'summarization'← LLM compressing transcripts
  'improvement'  ← LLM proposing prompt changes

GET /cost → SELECT SUM(cost) FROM api_cost_log

Hard stop in learning-loop.ts:
  if (await getTotalCost()) >= 18:
    console.log("HARD STOP: $18 reached")
    return  ← stops further iterations

Actual cost for full eval run (seed=42):
  Total: $0.14  (Groq free tier = $0; OpenRouter earlier tests = $0.14)
```

---

## 13. End-to-End Request Timeline

```
Timeline for one interactive chat turn (typical ~3-5 seconds on Groq):

0ms      User sends POST /chat/:wfId/message {"message": "Hello"}
  │
10ms     api/server.ts receives request
  │
15ms     Temporal Update dispatched to workflow
  │
20ms     Worker receives Update, schedules processA1ChatMessageActivity
  │
30ms     Activity starts:
          ├── SELECT transcript FROM conversation_transcripts  (~5ms)
          └── reconstruct AssessmentAgent with history
  │
50ms     POST Groq API (llama-3.1-8b-instant)
  │
2500ms   LLM responds (~1-3s typical on Groq)
          Note: if rate-limited, waits Xs and retries (up to 30 times)
  │
2510ms   logApiCall to Postgres
2515ms   UPDATE conversation_transcripts in Postgres
2520ms   Activity returns { reply, complete }
  │
2525ms   Workflow Update handler returns reply
  │
2530ms   HTTP response sent: { reply, workflowId }
```

---

## 14. How Temporal Keeps Everything Safe

```
Why Temporal (not just async/await)?

Problem: Debt collections conversations can take days.
A borrower might not respond for hours. The server can't
hold a Promise open for 48 hours.

Temporal solution:
  ├── Workflow state is persisted to Postgres after every step
  ├── If the server crashes, the workflow resumes from where it stopped
  ├── Activities are idempotent — safe to retry on failure
  ├── Signals (vapiCallEndedSignal) can arrive hours later
  └── The 60-minute Vapi wait is a Temporal timer, not an open socket

Temporal replay rule (critical):
  ├── Workflow code must be DETERMINISTIC
  ├── No Date.now(), Math.random(), or direct API calls in workflow file
  ├── All non-deterministic work goes in ACTIVITIES
  └── We use workflowInfo().workflowId (deterministic) not Date.now()

Self-hosted v1.24 vs Temporal Cloud:
  ├── Temporal Updates work for intra-stage chat (executeUpdate)
  ├── Cross-stage transitions use Signals (not Updates)
  │    Reason: self-hosted v1.24 doesn't support workflow.executeUpdate
  │    for cross-workflow signaling patterns
  └── This is a known limitation of the self-hosted free tier
```

---

## 15. Running Checklist

```
Before running anything:

□ GROQ_API_KEY added to .env  (get free at console.groq.com)
□ (For voice) VAPI_API_KEY added to .env
□ (For voice) VAPI_PUBLIC_KEY added to .env
□ (For voice) VAPI_ASSISTANT_ID added to .env  ← must be PUBLISHED in dashboard
□ (For outbound calls) VAPI_PHONE_NUMBER_ID added to .env
□ Docker Desktop is open (whale icon in menu bar is steady)

Start:
□ ./scripts/dev.sh start
□ ./scripts/dev.sh status  ← verify all green

Test (no API key needed):
□ ./scripts/run.sh dgm     ← DGM demo

Test (API key needed):
□ ./scripts/run.sh trigger
□ Open the /agent1 URL that prints (or copy wfId and use chat command)
□ When assessment done → voice call page opens automatically
□ Click green button → speak as borrower → hang up
□ Agent 3 final notice chat opens automatically

Full eval:
□ ./scripts/run.sh eval    ← runs ~45-90 min (Groq rate limits), costs ~$0 on free tier
□ To skip assessment if already done: SKIP_ASSESSMENT=true bash scripts/run.sh eval

Stop:
□ ./scripts/dev.sh stop
```

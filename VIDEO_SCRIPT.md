# Demo Video Script
**Target length: 4-5 minutes | ~550 words at 120 wpm**
*[Screen cues in brackets] — read this enough times to say it naturally, not word for word*

---

## SECTION 1 — THE ASSIGNMENT GAVE ME THE STRUCTURE (20 seconds)
*[Show the 3-agent architecture diagram or workflow_execution.md]*

> "So the assignment already defined the broad structure —
> three AI agents, each handling a different stage of a debt collections conversation.
> What I want to show you is the decisions I made in how to actually build this,
> why I built it the way I did, and how each piece works — in plain English."

---

## SECTION 2 — THE BIGGEST DECISION: TEMPORAL (60 seconds)
*[Show terminal with `./scripts/dev.sh status`, all services green]*

> "The first big decision was how to connect these three agents together.
>
> Here's the problem. A real debt conversation doesn't happen in one second.
> Agent 1 chats with the borrower — that might take 10 minutes.
> Then Agent 2 has to call them on the phone — that might be scheduled for tomorrow.
> Then Agent 3 sends a final notice — maybe two days later.
>
> If I just used normal code — a normal function call — the moment the server restarts,
> or crashes, or the internet drops for a second,
> the entire conversation is lost. Gone. Start from scratch.
>
> So I used something called Temporal.
> Think of Temporal like a very reliable notepad that never forgets.
> Every single step the system takes — it writes it down immediately.
> If the server crashes, burns down, loses power — doesn't matter.
> When it comes back, Temporal looks at its notepad and says
> 'okay, we were at step 2, let's continue from there.'
>
> That's why Temporal. Not because it's fancy — because debt conversations span days,
> and I can't afford to lose state."

*[Point to the three containers on screen — postgres, temporal, temporal-ui]*

> "You can see it running right here. Postgres stores the data.
> Temporal manages the steps. And there's even a visual dashboard
> where you can watch a conversation move through each stage in real time."

---

## SECTION 3 — LIVE DEMO: STARTING A CONVERSATION (60 seconds)
*[Run: `./scripts/run.sh trigger` — browser opens automatically to /agent1]*

> "Let me actually trigger one live.
> When this runs, Temporal creates a new workflow — think of it as opening a new file
> for this borrower. The browser opens automatically to Agent 1.
> I'll type as the borrower."

*[Type a message in the browser chat: "Hello, I got your message"]*

> "Watch what happens — the agent immediately tells me it's an AI,
> tells me the call is being recorded, and starts asking for information.
> That's not accidental — those are legal compliance requirements.
> The agent is not allowed to pretend to be human. Ever."

*[Type one more turn: "Yes this is me, John Smith, account ending 4321"]*

> "Every message goes to the Temporal workflow, which calls an activity,
> which calls the LLM — in our case Groq, which is free —
> gets the reply, saves the full conversation to Postgres,
> and returns the reply. All in about 2-3 seconds.
> When Agent 1 decides it has enough information,
> it outputs a JSON completion signal, and the workflow automatically
> moves to stage 2 — the voice call."

---

## SECTION 4 — THE HANDOFF PROBLEM: 500 TOKENS (40 seconds)
*[Show workflow_execution.md Section 5 — context summarizer]*

> "Here's a challenge nobody talks about.
> When Agent 1 finishes and hands over to the voice call,
> Agent 2 needs to know what was discussed. But it can't get the full conversation.
>
> Each agent has a strict budget of 2000 tokens — roughly a page and a half.
> That has to include the agent's instructions AND the conversation history.
>
> So I built a summarizer. It takes the full Agent 1 conversation
> and compresses it into under 500 tokens. Like a briefing note.
> Only the critical facts: identity confirmed, debt amount, job situation, emotional state.
>
> And this isn't just a guideline. The code literally counts the tokens
> and throws an error if the summary is too long.
> It tries three times with progressively shorter limits before giving up.
> Agent 2 starts the voice call already knowing who this person is.
> No re-introduction. No asking the same questions again."

---

## SECTION 5 — THE SELF-LEARNING LOOP: WHY AND HOW (60 seconds)
*[Show data/results/evaluation_scores.csv briefly, or the terminal eval output]*

> "Now here's the part I'm most proud of.
> These agents improve themselves automatically.
>
> Here's the simple version of what happens.
> Every iteration, the system generates 15 fake conversations —
> the LLM plays the agent, and a different call to the same LLM plays the borrower.
> Then it scores every conversation on five things:
> Did the conversation move toward resolution? Did the agent follow the rules?
> Was it efficient? Did it use the context from the previous agent properly?
>
> Then it asks the LLM to suggest one small change to the agent's instructions
> to fix the weakest area.
>
> But it doesn't just accept that change.
> It runs another 15 conversations with the new instructions
> and compares the scores using a statistical test — Welch's t-test —
> that I wrote from scratch.
>
> The change only gets adopted if the improvement is statistically significant —
> p-value under 0.05 AND an effect size above 0.2.
> In plain English: probably not luck, AND big enough to matter.
>
> In our actual eval run — all three agents ran through this.
> The compliance checker blocked the proposed v2 improvements —
> which brings me to the most interesting part."

---

## SECTION 6 — THE SYSTEM IMPROVES ITS OWN JUDGING (50 seconds)
*[Run: `./scripts/run.sh dgm`]*

> "Before any new prompt gets adopted — even if the stats look great —
> it goes through a compliance checker. Eight rules.
> Things like: did the agent identify itself as AI?
> Is it threatening arrest? Is it disclosing that the call is recorded?
>
> Now here's what makes this interesting.
> I intentionally put a flaw in the compliance checker.
> Rule number one is supposed to check that the agent identifies itself as an AI.
> But I made that rule do nothing in version 1 — it always passes.
>
> Watch what happens when the meta-evaluator runs."

*[Show the output: BLIND SPOT detected → Ruleset v1.0 → v1.1]*

> "It ran test prompts against its own compliance checker.
> It noticed that a prompt with no AI disclosure passed when it shouldn't.
> It flagged this as a blind spot.
> And then automatically — it patched the checker.
> Version 1.0 became version 1.1.
> From that point on, any future prompt without AI disclosure gets rejected.
>
> This concept is called a Darwin Godel Machine —
> a system that doesn't just improve its outputs,
> but improves its ability to judge its own outputs.
>
> And in the real eval run, this mattered:
> the upgraded checker then rejected the proposed v2 prompts for all three agents.
> The system found a flaw in itself, fixed it, and the fix immediately caught
> non-compliant proposed improvements. Without me touching anything."

---

## SECTION 7 — CLOSE (15 seconds)
*[Show `./scripts/dev.sh status` — all green. Show the data/results/ folder]*

> "Everything runs in Docker — starts in under 10 seconds.
> One command runs the entire evaluation pipeline and outputs a CSV
> with every conversation scored, and a JSON showing exactly how each prompt evolved.
> Fully reproducible. Same seed, same results every time.
> Total LLM cost for the full eval: 14 cents — on a free API.
> Thanks."

---

## COMMANDS IN RECORDING ORDER

```bash
./scripts/dev.sh status                    # show all green
./scripts/run.sh trigger                   # browser opens to /agent1 — type as borrower
# → type in browser: "Hello, I got your message"
# → type in browser: "Yes this is me, John Smith, account ending 4321"
./scripts/run.sh dgm                       # DGM live demo — show v1.0 → v1.1
ls data/results/                           # show output files
```

## KEY NUMBERS TO NATURALLY DROP

- **2000 tokens** — context window per agent
- **500 tokens** — max handoff (enforced in code, throws error if over)
- **15 conversations** per prompt version before testing
- **p < 0.05 AND Cohen's d > 0.2** — both must pass to adopt
- **8 compliance rules** checked on every prompt update
- **$0.14 total cost** for the full eval (Groq free tier = $0)
- **v1.0 → v1.1** — DGM upgraded the compliance checker mid-eval
- **3 v2 proposals rejected** — compliance gate caught them all (system working correctly)

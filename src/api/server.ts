import express, { Application, Request, Response } from 'express';
import dotenv from 'dotenv';
import { Client, Connection } from '@temporalio/client';
import { db, getTotalCost } from '../db/db.js';
import { borrowerWorkflow, vapiCallEndedSignal, assessmentDoneSignal, finalNoticeDoneSignal } from '../temporal/workflows/borrower.workflow.js';
import { processA1ChatMessageActivity, processA3ChatMessageActivity } from '../temporal/activities/chat.activity.js';
import type { BorrowerProfile } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app: Application = express();
app.use(express.json());

const TASK_QUEUE = 'riverline-collections';

let temporalClient: Client | null = null;

async function getTemporalClient(): Promise<Client> {
  if (!temporalClient) {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    });
    temporalClient = new Client({ connection, namespace: 'default' });
  }
  return temporalClient;
}

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'riverline-collections-api',
    timestamp: new Date().toISOString(),
  });
});

// GET /agent1?wfId=xxx — Agent 1 (Assessment) chat UI
app.get('/agent1', (req: Request, res: Response) => {
  const wfId = (req.query.wfId as string) ?? '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Riverline — Assessment (Agent 1)</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;height:100vh;display:flex;flex-direction:column}
    header{padding:1rem 1.5rem;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:.75rem}
    header h1{font-size:1rem;font-weight:600}
    #badge{padding:.2rem .6rem;border-radius:999px;font-size:.7rem;font-weight:700;background:#1e3a5f;color:#93c5fd}
    #progress{padding:.5rem 1.5rem;background:#0d1b2e;border-bottom:1px solid #1e293b;font-size:.75rem;color:#475569;display:flex;gap:1.5rem}
    .step{display:flex;align-items:center;gap:.4rem}.step.done{color:#22c55e}.step.active{color:#60a5fa}.step.pending{color:#334155}
    #msgs{flex:1;overflow-y:auto;padding:1.5rem;display:flex;flex-direction:column;gap:.75rem}
    .wrap{display:flex;flex-direction:column}
    .lbl{font-size:.65rem;font-weight:700;opacity:.5;text-transform:uppercase;margin-bottom:.2rem}
    .bubble{max-width:72%;padding:.75rem 1rem;border-radius:12px;font-size:.9rem;line-height:1.55}
    .agent{align-self:flex-start}.agent .bubble{background:#1e293b;color:#e2e8f0;border-bottom-left-radius:2px}
    .user{align-self:flex-end}.user .bubble{background:#1d4ed8;color:#fff;border-bottom-right-radius:2px}
    .typing .bubble{opacity:.5;font-style:italic}
    footer{padding:.75rem 1rem;border-top:1px solid #1e293b;display:flex;gap:.5rem}
    #input{flex:1;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:.65rem 1rem;color:#f1f5f9;font-size:.9rem;outline:none}
    #input:focus{border-color:#3b82f6}
    #send{background:#3b82f6;color:white;border:none;border-radius:8px;padding:.65rem 1.2rem;cursor:pointer;font-weight:600}
    #send:disabled{opacity:.4;cursor:not-allowed}
    #redirect-msg{display:none;padding:1rem;background:#052e16;color:#86efac;text-align:center;font-weight:600;border-top:1px solid #166534}
  </style>
</head>
<body>
  <header>
    <span>📋</span>
    <h1>Assessment Agent — Riverline Financial (Agent 1)</h1>
    <span id="badge">LIVE</span>
  </header>
  <div id="progress">
    <div class="step active">● Step 1: Assessment (you are here)</div>
    <div class="step pending">○ Step 2: Voice call</div>
    <div class="step pending">○ Step 3: Final notice</div>
  </div>
  <div id="msgs"></div>
  <div id="redirect-msg">✓ Assessment complete — connecting you to the voice agent now...</div>
  <footer>
    <input id="input" placeholder="Type your response..." onkeydown="if(event.key==='Enter')send()" />
    <button id="send" onclick="send()">Send</button>
  </footer>

  <script>
    const WF_ID = "${wfId}";
    let busy = false;

    function addMsg(role, text) {
      const wrap = document.createElement('div');
      wrap.className = 'wrap ' + (role === 'agent' ? 'agent' : 'user');
      const clean = text.replace(/\\{"assessment_complete".*\\}/s, '').trim();
      wrap.innerHTML = '<div class="lbl">' + (role === 'agent' ? 'Agent 1 — Assessment' : 'You') + '</div><div class="bubble">' + (clean||text).replace(/\\n/g,'<br>') + '</div>';
      document.getElementById('msgs').appendChild(wrap);
      wrap.scrollIntoView({behavior:'smooth'});
      return wrap;
    }

    function setTyping(on) {
      const ex = document.getElementById('typing');
      if (on && !ex) { const w=addMsg('agent','...'); w.id='typing'; w.classList.add('typing'); }
      else if (!on && ex) { ex.remove(); }
    }

    async function chat(msg) {
      if (busy) return;
      busy = true;
      document.getElementById('send').disabled = true;
      setTyping(true);
      try {
        const res = await fetch('/chat/' + WF_ID + '/message', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({message: msg})
        });
        const d = await res.json();
        setTyping(false);
        if (d.reply) {
          addMsg('agent', d.reply);
          if (d.agentId === 'waiting_for_voice' || d.complete) {
            // Assessment done — update progress and redirect to voice call
            document.querySelectorAll('.step')[0].className = 'step done';
            document.querySelectorAll('.step')[1].className = 'step active';
            document.getElementById('input').disabled = true;
            document.getElementById('send').style.display = 'none';
            document.getElementById('redirect-msg').style.display = 'block';
            setTimeout(() => {
              window.location.href = '/call?wfId=' + WF_ID;
            }, 2000);
          }
        }
      } catch(e) {
        setTyping(false);
        addMsg('agent', 'Error: ' + e.message);
      }
      busy = false;
      document.getElementById('send').disabled = false;
    }

    function send() {
      const input = document.getElementById('input');
      const msg = input.value.trim();
      if (!msg || busy) return;
      input.value = '';
      addMsg('user', msg);
      chat(msg);
    }

    // Auto-send "Hello" so agent speaks its opening line first
    window.addEventListener('load', () => {
      setTimeout(() => chat('Hello'), 600);
    });
  </script>
</body>
</html>`);
});

// GET /call?wfId=xxx — Vapi Web SDK page with live transcript + auto webhook on call end
app.get('/call', (req: Request, res: Response) => {
  const publicKey  = process.env.VAPI_PUBLIC_KEY   ?? '';
  const assistantId = process.env.VAPI_ASSISTANT_ID ?? '';
  const workflowId  = (req.query.wfId as string)   ?? '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Riverline — Agent 2 Voice Call</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;height:100vh;display:flex;flex-direction:column}
    header{padding:1.2rem 1.5rem;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:.75rem}
    header h1{font-size:1.1rem;font-weight:600}
    #badge{padding:.25rem .75rem;border-radius:999px;font-size:.75rem;font-weight:600;background:#1e293b;color:#64748b}
    #badge.active{background:#052e16;color:#22c55e}
    #badge.ended{background:#2d1515;color:#ef4444}
    #transcript{flex:1;overflow-y:auto;padding:1.5rem;display:flex;flex-direction:column;gap:.75rem}
    .msg{max-width:70%;padding:.75rem 1rem;border-radius:12px;font-size:.95rem;line-height:1.5}
    .agent{align-self:flex-start;background:#1e293b;color:#e2e8f0;border-bottom-left-radius:2px}
    .user{align-self:flex-end;background:#1d4ed8;color:#fff;border-bottom-right-radius:2px}
    .label{font-size:.7rem;font-weight:600;margin-bottom:.25rem;opacity:.7;text-transform:uppercase}
    .partial{opacity:.5;font-style:italic}
    footer{padding:1rem 1.5rem;border-top:1px solid #1e293b;color:#475569;font-size:.8rem;text-align:center}
    #autoMsg{color:#22c55e;display:none;margin-top:.5rem}
  </style>
</head>
<body>
  <header>
    <span>🎙</span>
    <h1>Riverline Financial — Resolution Agent (Agent 2)</h1>
    <span id="badge">Idle</span>
  </header>
  <div id="transcript">
    <div style="text-align:center;color:#475569;margin-top:3rem">
      <div style="font-size:2rem;margin-bottom:1rem">📞</div>
      <div>Click the green button (bottom-right) to start the call</div>
      <div style="font-size:.8rem;margin-top:.5rem;color:#334155">The transcript will appear here live</div>
    </div>
  </div>
  <footer>
    When you hang up, Agent 3 (Final Notice) fires automatically
    <div id="autoMsg">✓ Call ended — Agent 3 is being notified...</div>
  </footer>

  <script>
    const WORKFLOW_ID = "${workflowId}";
    const transcripts = [];
    let callId = null;

    function addMessage(role, text, partial) {
      // Remove previous partial for same role
      const prevPartial = document.querySelector('.partial.' + role);
      if (prevPartial) prevPartial.parentElement.remove();

      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = role === 'assistant' ? 'Agent 2' : 'You';
      const bubble = document.createElement('div');
      bubble.className = 'msg ' + role + (partial ? ' partial' : '');
      bubble.textContent = text;
      wrap.appendChild(label);
      wrap.appendChild(bubble);
      document.getElementById('transcript').appendChild(wrap);
      wrap.scrollIntoView({ behavior: 'smooth' });

      if (!partial) transcripts.push({ role, text });
    }

    function setBadge(text, cls) {
      const b = document.getElementById('badge');
      b.textContent = text;
      b.className = cls;
    }

    async function onCallEnd() {
      setBadge('Ended', 'ended');
      document.getElementById('autoMsg').style.display = 'block';

      if (!WORKFLOW_ID) return;

      // Build transcript string from collected messages
      const transcriptText = transcripts
        .map(m => (m.role === 'assistant' ? 'Agent: ' : 'Borrower: ') + m.text)
        .join('\\n');

      // Auto-fire webhook — advances Temporal workflow to Agent 3
      try {
        await fetch('/webhooks/vapi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'end-of-call-report',
            transcript: transcriptText || 'Call completed.',
            call: { id: callId || 'call_web', metadata: { workflowId: WORKFLOW_ID } }
          })
        });
        document.getElementById('autoMsg').textContent = '✓ Call ended — redirecting to Agent 3...';
        setTimeout(() => {
          window.location.href = '/agent3?wfId=' + WORKFLOW_ID;
        }, 1500);
      } catch(e) {
        document.getElementById('autoMsg').textContent = 'Call ended. Webhook failed: ' + e.message;
      }
    }

    (function(d,t){
      var g=document.createElement(t),s=d.getElementsByTagName(t)[0];
      g.src="https://cdn.jsdelivr.net/gh/VapiAI/html-script-tag@latest/dist/assets/index.js";
      g.defer=g.async=true;
      s.parentNode.insertBefore(g,s);
      g.onload=function(){
        const inst = window.vapiSDK.run({
          apiKey: "${publicKey}",
          assistant: "${assistantId}",
          config: {
            position:"bottom-right", offset:"40px", width:"56px", height:"56px",
            idle:   { color:"rgb(34,197,94)", type:"round", title:"Start Call",    subtitle:"Talk to Agent 2" },
            loading:{ color:"rgb(234,179,8)", type:"round", title:"Connecting...", subtitle:"Please wait"    },
            active: { color:"rgb(239,68,68)", type:"round", title:"In Call",       subtitle:"Click to end"   }
          }
        });
        window.vapiInstance = inst;

        // Attach event listeners directly on the instance
        inst.on('call-start', function(e) {
          callId = e?.callId || null;
          setBadge('Live', 'active');
          document.getElementById('transcript').innerHTML = '';
        });
        inst.on('call-end', function() { onCallEnd(); });
        inst.on('speech-start', function() { setBadge('Speaking...', 'active'); });
        inst.on('speech-end',   function() { setBadge('Live', 'active'); });
        inst.on('message', function(msg) {
          if (msg?.type === 'transcript') {
            addMessage(msg.role || 'assistant', msg.transcript || '', msg.transcriptType === 'partial');
          }
        });
        inst.on('error', function(e) {
          setBadge('Error', 'ended');
          console.error('Vapi error:', e);
        });
      };
    })(document,"script");
  </script>
</body>
</html>`);
});

// GET /agent3?wfId=xxx — Agent 3 (Final Notice) chat UI
app.get('/agent3', (req: Request, res: Response) => {
  const wfId = (req.query.wfId as string) ?? '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Riverline — Final Notice (Agent 3)</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;height:100vh;display:flex;flex-direction:column}
    header{padding:1rem 1.5rem;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:.75rem}
    header h1{font-size:1rem;font-weight:600}
    #badge{padding:.2rem .6rem;border-radius:999px;font-size:.7rem;font-weight:700;background:#7f1d1d;color:#fca5a5;letter-spacing:.05em}
    #msgs{flex:1;overflow-y:auto;padding:1.5rem;display:flex;flex-direction:column;gap:.75rem}
    .wrap{display:flex;flex-direction:column}
    .lbl{font-size:.65rem;font-weight:700;opacity:.5;text-transform:uppercase;margin-bottom:.2rem}
    .bubble{max-width:72%;padding:.75rem 1rem;border-radius:12px;font-size:.9rem;line-height:1.55}
    .agent{align-self:flex-start}.agent .bubble{background:#1e293b;color:#e2e8f0;border-bottom-left-radius:2px}
    .user{align-self:flex-end}.user .bubble{background:#b91c1c;color:#fff;border-bottom-right-radius:2px}
    .typing .bubble{opacity:.5;font-style:italic}
    footer{padding:.75rem 1rem;border-top:1px solid #1e293b;display:flex;gap:.5rem}
    #input{flex:1;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:.65rem 1rem;color:#f1f5f9;font-size:.9rem;outline:none}
    #input:focus{border-color:#ef4444}
    #send{background:#ef4444;color:white;border:none;border-radius:8px;padding:.65rem 1.2rem;cursor:pointer;font-weight:600}
    #send:disabled{opacity:.4;cursor:not-allowed}
    #done{display:none;background:#166534;color:#bbf7d0;border:none;border-radius:8px;padding:.65rem 1.2rem;font-weight:600}
  </style>
</head>
<body>
  <header>
    <span>⚠️</span>
    <h1>Final Notice — Riverline Financial (Agent 3)</h1>
    <span id="badge">FINAL NOTICE</span>
  </header>
  <div id="msgs"></div>
  <footer>
    <input id="input" placeholder="Type your response..." onkeydown="if(event.key==='Enter')send()" />
    <button id="send" onclick="send()">Send</button>
    <button id="done">✓ Resolved</button>
  </footer>

  <script>
    const WF_ID = "${wfId}";
    let busy = false;

    function addMsg(role, text) {
      const wrap = document.createElement('div');
      wrap.className = 'wrap ' + (role === 'agent' ? 'agent' : 'user');
      wrap.innerHTML = '<div class="lbl">' + (role === 'agent' ? 'Agent 3 — Final Notice' : 'You') + '</div><div class="bubble">' + text.replace(/\\n/g,'<br>') + '</div>';
      document.getElementById('msgs').appendChild(wrap);
      wrap.scrollIntoView({behavior:'smooth'});
      return wrap;
    }

    function setTyping(on) {
      const existing = document.getElementById('typing');
      if (on && !existing) {
        const w = addMsg('agent', '...');
        w.id = 'typing'; w.classList.add('typing');
      } else if (!on && existing) {
        existing.remove();
      }
    }

    async function chat(msg) {
      if (busy) return;
      busy = true;
      document.getElementById('send').disabled = true;
      setTyping(true);
      try {
        const res = await fetch('/chat/' + WF_ID + '/message', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({message: msg})
        });
        const d = await res.json();
        setTyping(false);
        if (d.reply) {
          addMsg('agent', d.reply);
          if (d.complete || d.agentId === 'completed') {
            document.getElementById('input').disabled = true;
            document.getElementById('send').style.display = 'none';
            document.getElementById('done').style.display = 'inline-block';
          }
        }
      } catch(e) {
        setTyping(false);
        addMsg('agent', 'Error: ' + e.message);
      }
      busy = false;
      document.getElementById('send').disabled = false;
    }

    function send() {
      const input = document.getElementById('input');
      const msg = input.value.trim();
      if (!msg || busy) return;
      input.value = '';
      addMsg('user', msg);
      chat(msg);
    }

    // Auto-send "Hello" on page load to get Agent 3's opening statement
    window.addEventListener('load', () => {
      setTimeout(() => chat('Hello'), 800);
    });
  </script>
</body>
</html>`);
});

// GET /cost — current LLM spend
app.get('/cost', async (_req: Request, res: Response) => {
  try {
    const total = await getTotalCost();
    res.json({ totalCostUsd: total.toFixed(4), hardStopAt: 18.0 });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /borrowers/:id/start — trigger a new Temporal workflow
app.post('/borrowers/:id/start', async (req: Request, res: Response) => {
  const { borrowerProfile } = req.body as { borrowerProfile: BorrowerProfile };
  if (!borrowerProfile) {
    res.status(400).json({ error: 'borrowerProfile required' });
    return;
  }

  const workflowId = `borrower-${borrowerProfile.borrowerId}-${uuidv4()}`;

  try {
    // Store profile + initial agent state so the chat endpoint can load it
    await db.query(
      `INSERT INTO borrower_workflows (id, borrower_id, status, outcome) VALUES ($1, $2, 'running', $3)`,
      [workflowId, borrowerProfile.borrowerId, JSON.stringify({ borrowerProfile, currentAgent: 'assessment' })]
    );

    const client = await getTemporalClient();
    await client.workflow.start(borrowerWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{ borrowerProfile, maxAssessmentRetries: 3, mode: 'interactive' }],
    });

    res.json({ workflowId, status: 'started' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /chat/:workflowId/message — send a message to the active chat agent (A1 or A3).
// Calls the agent directly (no Temporal Update — Updates are disabled on self-hosted Temporal 1.24).
// Signals the Temporal workflow when an agent completes so it advances to the next stage.
app.post('/chat/:workflowId/message', async (req: Request, res: Response) => {
  const workflowId = req.params.workflowId as string;
  const { message } = req.body as { message?: string };

  if (!message?.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    // Load workflow state (borrowerProfile + currentAgent) from DB
    const wfRow = await db.query<{ outcome: { borrowerProfile: BorrowerProfile; currentAgent: string } }>(
      'SELECT outcome FROM borrower_workflows WHERE id = $1',
      [workflowId],
    );
    if (!wfRow.rows.length) { res.status(404).json({ error: 'workflow not found' }); return; }

    const { borrowerProfile, currentAgent } = wfRow.rows[0].outcome;

    let reply: string;
    let complete = false;
    let agentId = currentAgent;

    if (currentAgent === 'assessment') {
      const result = await processA1ChatMessageActivity(message, borrowerProfile, workflowId);
      reply = result.reply;
      complete = result.complete;

      if (complete) {
        // Signal Temporal to advance past A1 → A2
        const client = await getTemporalClient();
        await client.workflow.getHandle(workflowId).signal(assessmentDoneSignal);
        // Mark workflow as waiting for voice call
        await db.query(
          `UPDATE borrower_workflows SET outcome = jsonb_set(outcome, '{currentAgent}', '"waiting_for_voice"') WHERE id = $1`,
          [workflowId],
        );
        agentId = 'waiting_for_voice';
      }

    } else if (currentAgent === 'final_notice') {
      // Load handoff content for A3
      const handoffRow = await db.query<{ payload: string }>(
        `SELECT payload FROM handoff_payloads WHERE workflow_id = $1 AND to_agent = 'final_notice' ORDER BY created_at DESC LIMIT 1`,
        [workflowId],
      );
      const handoffContent = handoffRow.rows[0]?.payload ?? 'No prior context available.';
      const result = await processA3ChatMessageActivity(message, borrowerProfile, handoffContent, workflowId);
      reply = result.reply;
      complete = result.complete;

      if (complete) {
        const outcome = reply.includes('"outcome":"resolved"') || reply.includes('"outcome": "resolved"')
          ? 'resolved' : 'no_resolution';
        const client = await getTemporalClient();
        await client.workflow.getHandle(workflowId).signal(finalNoticeDoneSignal, outcome);
        await db.query(
          `UPDATE borrower_workflows SET outcome = jsonb_set(outcome, '{currentAgent}', '"completed"') WHERE id = $1`,
          [workflowId],
        );
        agentId = 'completed';
      }

    } else {
      reply = currentAgent === 'waiting_for_voice'
        ? 'Your voice call is being scheduled. You will receive a call shortly.'
        : 'This conversation has concluded.';
    }

    res.json({ reply: reply!, workflowId, agentId, complete });
  } catch (err: any) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /workflows/:workflowId/call-url — returns the Vapi web call URL when ready
app.get('/workflows/:workflowId/call-url', async (req: Request, res: Response) => {
  const workflowId = req.params.workflowId as string;
  try {
    const row = await db.query<{ outcome: Record<string, string> }>(
      'SELECT outcome FROM borrower_workflows WHERE id = $1',
      [workflowId],
    );
    const outcome = row.rows[0]?.outcome ?? {};
    const url = outcome.webCallUrl ?? '';
    const callId = outcome.vapiCallId ?? '';
    if (url) {
      res.json({ ready: true, webCallUrl: url, callId });
    } else {
      res.json({ ready: false, note: 'Call not created yet or using phone mode' });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /webhooks/vapi — Vapi end-of-call webhook
app.post('/webhooks/vapi', async (req: Request, res: Response) => {
  const body = req.body as {
    message?: { type?: string; transcript?: string; call?: { id: string; metadata?: { workflowId?: string } } };
    // Vapi also sends flat structure for some event types
    type?: string;
    transcript?: string;
    call?: { id: string; metadata?: { workflowId?: string } };
  };

  // Vapi wraps events in a `message` field in newer SDK versions
  const event = body.message ?? body;
  const { type, transcript, call } = event as {
    type?: string;
    transcript?: string;
    call?: { id: string; metadata?: { workflowId?: string } };
  };

  if (type !== 'end-of-call-report' || !transcript) {
    res.status(200).json({ received: true });
    return;
  }

  // workflowId is embedded in call.metadata by createVapiCall — no DB lookup needed.
  const workflowId = call?.metadata?.workflowId;
  if (!workflowId) {
    res.status(200).json({ received: true, note: 'no workflowId in call metadata' });
    return;
  }

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal(vapiCallEndedSignal, transcript);

    // Update DB so chat endpoint knows Agent 3 is next.
    // Temporal will process parseResolution + summarize in the background (~5-10s).
    await db.query(
      `UPDATE borrower_workflows
       SET outcome = jsonb_set(outcome, '{currentAgent}', '"final_notice"')
       WHERE id = $1`,
      [workflowId],
    );

    console.log(`[webhook] vapiCallEndedSignal sent → workflowId=${workflowId}, stage=final_notice`);
    res.json({ received: true, workflowId, nextStage: 'final_notice' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /workflows/:workflowId/status
app.get('/workflows/:workflowId/status', async (req: Request, res: Response) => {
  const { workflowId } = req.params;
  try {
    const result = await db.query(
      'SELECT * FROM borrower_workflows WHERE id = $1',
      [workflowId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /eval/results — latest evaluation scores
app.get('/eval/results', async (_req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM evaluation_scores ORDER BY created_at DESC LIMIT 200'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`API server running on port ${port}`);
});

export { app };

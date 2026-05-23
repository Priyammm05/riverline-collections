import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const provider = process.env.LLM_PROVIDER ?? 'openrouter';
  console.log(`\nTesting API keys (LLM_PROVIDER=${provider})\n`);

  // ── OpenRouter ──────────────────────────────────────────────────────────────
  if (provider === 'openrouter' || process.env.OPENROUTER_API_KEY) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      console.log('✗ OPENROUTER_API_KEY not set');
    } else {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'google/gemini-3.1-flash-lite',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Say OK' }],
          }),
        });
        const data = await res.json() as any;
        if (res.ok) {
          console.log('✓ OpenRouter key works —', data.choices?.[0]?.message?.content?.trim());
          console.log('  Model: google/gemini-3.1-flash-lite');
        } else {
          console.log('✗ OpenRouter FAILED —', data.error?.message ?? res.status);
        }
      } catch (e: any) { console.log('✗ OpenRouter FAILED —', e.message); }
    }
  }

  // ── Anthropic ───────────────────────────────────────────────────────────────
  if (provider === 'anthropic' || process.env.ANTHROPIC_API_KEY) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      console.log('✗ ANTHROPIC_API_KEY not set');
    } else {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'Say OK' }] }),
        });
        const data = await res.json() as any;
        if (res.ok) {
          console.log('✓ Anthropic key works —', data.content?.[0]?.text?.trim());
        } else {
          console.log('✗ Anthropic FAILED —', data.error?.message ?? res.status);
        }
      } catch (e: any) { console.log('✗ Anthropic FAILED —', e.message); }
    }
  }

  // ── Vapi ────────────────────────────────────────────────────────────────────
  const vapiKey = process.env.VAPI_API_KEY;
  if (!vapiKey) {
    console.log('✗ VAPI_API_KEY not set');
  } else {
    try {
      const res = await fetch('https://api.vapi.ai/assistant?limit=1', {
        headers: { Authorization: `Bearer ${vapiKey}` },
      });
      if (res.ok) console.log('✓ Vapi key works — status', res.status);
      else console.log('✗ Vapi FAILED — status', res.status);
    } catch (e: any) { console.log('✗ Vapi FAILED —', e.message); }
  }

  console.log('');
}

main();

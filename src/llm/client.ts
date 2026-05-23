// Unified LLM adapter — supports OpenRouter, Anthropic, and Groq (free).
// Switch provider via LLM_PROVIDER env var (default: openrouter).

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { logApiCall } from '../db/db.js';
import type { ApiCallLog, ChatMessage } from '../types/index.js';

dotenv.config();

export const PROVIDER = (process.env.LLM_PROVIDER ?? 'openrouter') as 'openrouter' | 'anthropic' | 'groq' | 'cerebras';

// ── Model selection ───────────────────────────────────────────────────────────

const DEFAULTS = {
  openrouter: {
    agent: 'google/gemini-3.5-flash',
    eval:  'google/gemini-3.1-flash-lite',
  },
  anthropic: {
    agent: 'claude-sonnet-4-5',
    eval:  'claude-haiku-4-5-20251001',
  },
  groq: {
    agent: 'llama-3.3-70b-versatile',
    eval:  'llama-3.1-8b-instant',
  },
  cerebras: {
    agent: 'llama3.1-8b',   // 60K tokens/min free — fast inference
    eval:  'llama3.1-8b',
  },
};

export const MODEL_AGENT = process.env.AGENT_MODEL ?? DEFAULTS[PROVIDER].agent;
export const MODEL_EVAL  = process.env.EVAL_MODEL  ?? DEFAULTS[PROVIDER].eval;

// ── Pricing per 1M tokens ─────────────────────────────────────────────────────

const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-sonnet-4-5':         { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.25, output: 1.25 },
  // Google via OpenRouter
  'google/gemini-3.5-flash':       { input: 1.50, output: 6.00 },
  'google/gemini-3.1-flash-lite':  { input: 0.25, output: 1.00 },
  // Free models on OpenRouter
  'google/gemma-4-31b-it:free':             { input: 0, output: 0 },
  'deepseek/deepseek-v4-flash:free':        { input: 0, output: 0 },
  'meta-llama/llama-3.3-70b-instruct:free': { input: 0, output: 0 },
  // Groq — free tier
  'llama-3.3-70b-versatile': { input: 0, output: 0 },
  'llama-3.1-8b-instant':    { input: 0, output: 0 },
  'mixtral-8x7b-32768':      { input: 0, output: 0 },
  'gemma2-9b-it':            { input: 0, output: 0 },
  // Cerebras — free tier (60K tokens/min)
  'llama3.1-8b':             { input: 0, output: 0 },
};

export function computeLLMCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { input: 0.5, output: 1.5 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

// ── Provider implementations ──────────────────────────────────────────────────

export type LLMResponse = { text: string; inputTokens: number; outputTokens: number };

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callViaOpenAICompat(
  baseURL: string,
  apiKey: string,
  model: string,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  extraHeaders?: Record<string, string>,
): Promise<LLMResponse> {
  const client = new OpenAI({ baseURL, apiKey, defaultHeaders: extraHeaders, maxRetries: 0 });
  const allMessages = system
    ? [{ role: 'system' as const, content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))]
    : messages.map(m => ({ role: m.role, content: m.content }));

  const response = await client.chat.completions.create({ model, max_tokens: maxTokens, messages: allMessages });
  return {
    text: response.choices[0]?.message?.content ?? '',
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

async function callViaAnthropic(model: string, system: string, messages: ChatMessage[], maxTokens: number): Promise<LLMResponse> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model, max_tokens: maxTokens, system,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return { text, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

// ── Main entry point — with automatic rate-limit retry ───────────────────────

export async function callLLM(
  model: string,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  purpose: ApiCallLog['purpose'],
): Promise<LLMResponse> {
  const MAX_ATTEMPTS = 30; // enough to survive repeated per-minute rate limits

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let result: LLMResponse;

      if (PROVIDER === 'anthropic') {
        result = await callViaAnthropic(model, system, messages, maxTokens);
      } else if (PROVIDER === 'cerebras') {
        const key = process.env.CEREBRAS_API_KEY;
        if (!key) throw new Error('CEREBRAS_API_KEY not set in .env');
        result = await callViaOpenAICompat('https://api.cerebras.ai/v1', key, model, system, messages, maxTokens);
      } else if (PROVIDER === 'groq') {
        const key = process.env.GROQ_API_KEY;
        if (!key) throw new Error('GROQ_API_KEY not set in .env');
        result = await callViaOpenAICompat('https://api.groq.com/openai/v1', key, model, system, messages, maxTokens);
      } else {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key) throw new Error('OPENROUTER_API_KEY not set in .env');
        result = await callViaOpenAICompat(
          'https://openrouter.ai/api/v1', key, model, system, messages, maxTokens,
          { 'HTTP-Referer': 'https://github.com/riverline-collections', 'X-Title': 'Riverline Collections' },
        );
      }

      await logApiCall({
        model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        purpose,
        cost: computeLLMCost(model, result.inputTokens, result.outputTokens),
      });

      return result;

    } catch (err: any) {
      const isRetryable = err?.status === 429 || err?.status === 503 ||
        err?.code === 'ETIMEDOUT' || err?.name === 'APIConnectionTimeoutError' ||
        err?.message?.includes('timed out') || err?.message?.includes('ECONNRESET');

      if (isRetryable && attempt < MAX_ATTEMPTS) {
        // Extract wait time from error message (e.g. "Please try again in 10.87s")
        const msgMatch = err?.message?.match(/try again in ([\d.]+)s/);
        const retryAfterHeader = err?.headers?.get?.('retry-after');
        const waitSec = msgMatch
          ? parseFloat(msgMatch[1]) + 2
          : retryAfterHeader
            ? parseFloat(retryAfterHeader) + 1
            : Math.min(60, 5 * attempt);
        const reason = err?.status === 429 ? 'rate-limit' : 'timeout';
        process.stdout.write(`  [${reason}] ${model} — waiting ${waitSec.toFixed(0)}s (attempt ${attempt}/${MAX_ATTEMPTS})\n`);
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`callLLM: exceeded ${MAX_ATTEMPTS} retries due to rate limiting`);
}

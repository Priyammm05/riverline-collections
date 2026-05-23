import dotenv from 'dotenv';
dotenv.config();
import { callLLM, MODEL_AGENT, PROVIDER } from '../src/llm/client.js';

async function main() {
  console.log('Provider:', PROVIDER);
  console.log('Model:', MODEL_AGENT);
  try {
    const r = await callLLM(MODEL_AGENT, 'You are helpful.', [{role:'user', content:'Say OK'}], 10, 'agent');
    console.log('✓ Works:', r.text);
  } catch(e: any) {
    console.log('✗ Error:', e.message, e.status, e.error);
  }
}
main();

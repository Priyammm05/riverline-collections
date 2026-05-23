import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
import { ApiCallLog } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

db.on('error', (err) => {
  console.error('Unexpected DB client error:', err);
});

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function logApiCall(log: ApiCallLog): Promise<void> {
  await db.query(
    `INSERT INTO api_cost_log (id, model, input_tokens, output_tokens, purpose, cost)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv4(), log.model, log.inputTokens, log.outputTokens, log.purpose, log.cost]
  );
}

export async function getTotalCost(): Promise<number> {
  const result = await db.query<{ total: string }>(
    'SELECT COALESCE(SUM(cost), 0) AS total FROM api_cost_log'
  );
  return parseFloat(result.rows[0].total);
}

export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  // Prices per 1M tokens
  const pricing: Record<string, { input: number; output: number }> = {
    'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5-20251001': { input: 0.25, output: 1.25 },
  };
  const p = pricing[model] ?? { input: 3.0, output: 15.0 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

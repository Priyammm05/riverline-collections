CREATE TABLE IF NOT EXISTS borrower_workflows (
  id TEXT PRIMARY KEY,
  borrower_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'running' | 'completed' | 'failed'
  outcome JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_transcripts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES borrower_workflows(id),
  agent_id TEXT NOT NULL,         -- 'assessment' | 'resolution' | 'final_notice'
  modality TEXT NOT NULL,         -- 'chat' | 'voice'
  transcript JSONB NOT NULL,      -- array of {role, content} messages
  token_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS handoff_payloads (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES borrower_workflows(id),
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  payload TEXT NOT NULL,          -- compressed summary string
  token_count INTEGER NOT NULL,   -- must be ≤ 500
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  mean_score REAL,
  p_value REAL,
  adopted BOOLEAN DEFAULT FALSE,
  rollback_reason TEXT,
  evaluation_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evaluation_scores (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  resolution_rate REAL,
  compliance_score REAL,
  information_capture_rate REAL,
  handoff_quality REAL,
  conversation_efficiency REAL,
  overall_score REAL,
  compliance_violations JSONB,
  raw_transcript TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meta_evaluation_findings (
  id TEXT PRIMARY KEY,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  flaw TEXT NOT NULL,
  affected_metric TEXT NOT NULL,
  evidence_conversation_ids JSONB,
  proposed_fix TEXT NOT NULL,
  fix_adopted BOOLEAN DEFAULT FALSE,
  rubric_version_before TEXT NOT NULL,
  rubric_version_after TEXT
);

CREATE TABLE IF NOT EXISTS api_cost_log (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  cost REAL NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

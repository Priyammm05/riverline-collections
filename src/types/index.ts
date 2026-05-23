export type BorrowerProfile = {
  borrowerId: string;
  name: string;
  partialAccountNumber: string;   // last 4 digits only — compliance rule 8
  debtAmount: number;
  loanType: string;
};

export type AssessmentResult = {
  identityVerified: boolean;
  confirmedDebtAmount: number;
  monthlyIncome: number | null;
  employmentStatus: string;
  hardshipDisclosed: boolean;
  hardshipType: 'medical' | 'job_loss' | 'other' | null;
  emotionalState: 'calm' | 'distressed' | 'hostile' | 'confused';
  borrowerStatement: string;      // one-sentence summary of their stated position
  conversationTurns: number;
};

export type ResolutionResult = {
  offerPresented: 'lump_sum' | 'payment_plan' | 'hardship_referral';
  offerTerms: string;
  borrowerResponse: 'accepted' | 'rejected' | 'partial' | 'no_response';
  objectionsRaised: string[];
  callDurationSeconds: number;
  transcriptTokenCount: number;
};

export type HandoffPayload = {
  tokenCount: number;             // must be ≤ 500 — enforced before passing
  content: string;                // compressed summary string
};

export type WorkflowOutcome =
  | { status: 'deal_agreed'; details: string }
  | { status: 'resolved'; details: string }
  | { status: 'legal_referral'; reason: string }
  | { status: 'no_response_exhausted' };

export type BorrowerPersona =
  | 'cooperative'
  | 'combative'
  | 'distressed';

export type EvaluationScore = {
  conversationId: string;
  agentId: 'assessment' | 'resolution' | 'final_notice';
  promptVersion: string;
  resolutionRate: number;         // 0 or 1 (binary per conversation)
  complianceScore: number;        // 0–10
  informationCaptureRate: number; // 0–10 (A1 only)
  handoffQuality: number;         // 0–10
  conversationEfficiency: number; // 0–10
  overallScore: number;           // weighted average
  complianceViolations: string[]; // list of violated rules
  rawTranscript: string;
};

export type PromptVersion = {
  id: string;
  agentId: string;
  version: number;
  promptText: string;
  createdAt: Date;
  evaluationData: EvaluationScore[];
  meanScore: number;
  pValue: number | null;          // vs previous version
  adopted: boolean;
  rollbackReason: string | null;
};

export type MetaEvaluationFinding = {
  id: string;
  detectedAt: Date;
  flaw: string;                   // description of what was wrong
  affectedMetric: string;
  evidenceConversationIds: string[];
  proposedFix: string;
  fixAdopted: boolean;
  rubricVersionBefore: string;
  rubricVersionAfter: string | null;
};

export type AgentId = 'assessment' | 'resolution' | 'final_notice';

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type BorrowerWorkflowInput = {
  borrowerProfile: BorrowerProfile;
  maxAssessmentRetries: number;
  // 'autonomous' = canned/LLM borrower (learning loop, testing)
  // 'interactive' = real borrower via HTTP chat endpoint
  mode: 'autonomous' | 'interactive';
};

export type ApiCallLog = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  purpose: 'agent' | 'summarization' | 'evaluation' | 'meta_eval' | 'test_harness' | 'improvement';
  cost: number;
};

export type StatsResult = {
  meanA: number;
  meanB: number;
  stdDevA: number;
  stdDevB: number;
  tStatistic: number;
  pValue: number;
  cohensD: number;
  ci95A: [number, number];
  ci95B: [number, number];
  significant: boolean;           // p < 0.05 AND cohensD > 0.2
};

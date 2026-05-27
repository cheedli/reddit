// HTTP API contract between the Hono server and the React client.
// In the @devvit/web architecture, the client talks to the server via plain fetch().

export type ApiAction = 'remove' | 'filter' | 'report' | 'approve';

export type ApiPostItem = {
  kind: 'post';
  id: string;
  title: string;
  body: string;
  url: string;
  domain: string;
  author: string;
  authorId: string;
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number;
  authorIsMod: boolean;
  authorIsGold: boolean;
  authorFlairText: string;
  authorFlairCssClass: string;
  createdAt: number;
  edited: boolean;
  flairText: string;
  flairCssClass: string;
  reports: number;
  permalink: string;
  thumbnail?: string;
};

export type ApiCommentItem = {
  kind: 'comment';
  id: string;
  body: string;
  author: string;
  authorId: string;
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number;
  authorIsMod: boolean;
  authorIsGold: boolean;
  authorFlairText: string;
  authorFlairCssClass: string;
  createdAt: number;
  edited: boolean;
  flairText: string;
  flairCssClass: string;
  reports: number;
  permalink: string;
  postTitle: string;
  postId: string;
};

export type ApiItem = ApiPostItem | ApiCommentItem;

export type ApiMatchedCondition = {
  condition: string;
  matchedValue?: string;
  excerpt?: string;
};

export type ApiMatchResult = {
  matched: boolean;
  matchedConditions: ApiMatchedCondition[];
  action: ApiAction | null;
  actionReason?: string;
  item: ApiItem;
  ruleIndex: number;
};

export type ApiParseWarning = {
  ruleIndex: number;
  code:
    | 'empty-rule'
    | 'empty-text-condition'
    | 'invalid-regex'
    | 'missing-exception'
    | 'overly-broad-rule'
    | 'shadowed-rule'
    | 'unknown-action'
    | 'unknown-type'
    | 'unsupported-author-field'
    | 'unsupported-field'
    | 'unsupported-text-modifier';
  message: string;
  field?: string;
};

// GET /api/init
export type InitResponse = {
  subredditName: string;
  username: string;
  hasLlmKey: boolean;
  llmProvider: LlmProviderName;
  historyDays: number;
  cachedItemCount: number;
  cachedAt: number | null;
  falsePositiveIds: string[];
};

// POST /api/fetch-history
export type FetchHistoryRequest = { force?: boolean };
export type FetchHistoryResponse =
  | { status: 'ok'; items: ApiItem[]; totalFetched: number; fetchedAt: number }
  | { status: 'fetching'; message: string }
  | { status: 'error'; message: string };

// POST /api/evaluate
export type EvaluateRequest = { yaml: string };
export type EvaluateResponse =
  | {
      status: 'ok';
      results: ApiMatchResult[];
      evaluationMs: number;
      totalItems: number;
      warnings: ApiParseWarning[];
      unsupportedFields: string[];
    }
  | { status: 'error'; message: string };

// POST /api/translate
export type LlmProviderName = 'openai' | 'anthropic' | 'gemini';
export type TranslateRequest = { description: string; feedback?: string; currentYaml?: string };
export type TranslateResponse =
  | { status: 'ok'; yaml: string; reasoning: string; source: LlmProviderName | 'template' }
  | { status: 'error'; message: string };

export type LiveRuleState = {
  yaml: string | null;
  exists: boolean;
  revisionId: string | null;
  revisionDate: number | null;
  revisionReason: string | null;
  draftYaml: string | null;
  draftUpdatedAt: number | null;
  rollbackAvailable: boolean;
};

// GET /api/suggestions
export type SuggestionsResponse =
  | { status: 'ok'; suggestions: RuleSuggestion[] }
  | { status: 'error'; message: string; suggestions: RuleSuggestion[] };

// POST /api/dev/remove-training-items
export type DevRemoveTrainingItemsResponse =
  | {
      status: 'ok';
      removed: number;
      candidates: number;
      message: string;
    }
  | { status: 'error'; message: string };

// GET /api/live-rules
export type LiveRulesResponse =
  | { status: 'ok'; live: LiveRuleState }
  | { status: 'error'; message: string };

// POST /api/live-rules/draft
export type SaveDraftRequest = { yaml: string };
export type SaveDraftResponse =
  | { status: 'ok'; live: LiveRuleState; savedAt: number; message: string }
  | { status: 'error'; message: string };

// POST /api/live-rules/apply
export type ApplyLiveRulesRequest = { yaml: string; mode?: 'replace' | 'append' };
export type ApplyLiveRulesResponse =
  | { status: 'ok'; live: LiveRuleState; applied: boolean; message: string }
  | { status: 'error'; message: string };

// POST /api/live-rules/rollback
export type RollbackLiveRulesResponse =
  | { status: 'ok'; live: LiveRuleState; rolledBack: boolean; message: string }
  | { status: 'error'; message: string };

// POST /api/suggestions/seed
export type SeedSuggestionsResponse =
  | {
      status: 'ok';
      skipped: boolean;
      createdPosts: number;
      createdComments: number;
      removedPosts: number;
      removedComments: number;
      recordedRemovals: number;
      message: string;
    }
  | { status: 'error'; message: string };

// POST /api/false-positive
export type FalsePositiveRequest = { itemId: string };

export type RuleSuggestion = {
  id: string;
  yaml: string;
  reasoning: string;
  matchCount: number;
  totalRemovals: number;
  historyMatchCount: number;
  nonRemovalMatchCount: number;
  falsePositiveMatchCount: number;
  estimatedPrecision: number;
  estimatedRecall: number;
  confidence: 'low' | 'medium' | 'high';
  source: LlmProviderName | 'heuristic' | 'template';
  warningMessages: string[];
  exampleItems: Array<{ title?: string; body: string; author: string }>;
  createdAt: number;
};

export type ModRemovalRecord = {
  id: string;
  kind: 'post' | 'comment';
  title?: string;
  body: string;
  author: string;
  authorId?: string;
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number;
  authorIsMod?: boolean;
  authorIsGold?: boolean;
  moderator: string;
  removedAt: number;
  removalReason?: string;
  synthetic?: boolean;
  signalSource?: 'resolved' | 'snapshot' | 'fallback';
};

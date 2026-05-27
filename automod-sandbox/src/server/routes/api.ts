import { Hono } from 'hono';
import { context, reddit, settings } from '@devvit/web/server';
import { parseRules, ParseError } from '../../engine/parser.js';
import { evaluateAll } from '../../engine/evaluator.js';
import type { Item } from '../../engine/types.js';
import { store } from '../store.js';
import type {
  ApplyLiveRulesRequest,
  ApplyLiveRulesResponse,
  DevRemoveTrainingItemsResponse,
  EvaluateRequest,
  EvaluateResponse,
    FetchHistoryRequest,
    FalsePositiveRequest,
    FetchHistoryResponse,
    InitResponse,
    LiveRulesResponse,
    RollbackLiveRulesResponse,
    SaveDraftRequest,
    SaveDraftResponse,
    SeedSuggestionsResponse,
    SuggestionsResponse,
  TranslateRequest,
  TranslateResponse,
} from '../../shared/api.js';
import type { ModRemovalRecord } from '../../shared/api.js';
import { formatError, formatUserError, withRateLimitRetry } from '../core/errors.js';
import {
  getCachedHistory,
  getHistoryDaysSetting,
  loadSandboxHistory,
} from '../core/history.js';
import { translateDescriptionLocally } from '../core/localTranslate.js';
import { callLlm } from '../core/llm.js';
import type { LlmProvider } from '../core/llm.js';
import {
  addFalsePositiveId,
  appendModRemovalRecord,
  filterRealRemovalRecords,
  getFalsePositiveIds,
  getModRemovalRecords,
  writeModRemovalRecords,
} from '../core/moderationMemory.js';
import { hydrateRemovalRecord } from '../core/removalSignals.js';
import { generateRuleSuggestions } from '../core/suggestions.js';
import {
  applyLiveRules,
  getLiveRuleState,
  rollbackLiveRules,
  saveLiveDraft,
} from '../core/liveAutomod.js';

export const api = new Hono();

const DEV_SUBREDDIT = 'automod_sandbox_dev';
const TRAINING_KEYWORDS = [
  'telegram',
  'discount',
  'followers',
  'promo',
  'guaranteed',
  'offer',
  'buy',
  'cheap',
  'sale',
  'crypto',
];
type RemovableThingId = `t1_${string}` | `t3_${string}`;

function isDevSubreddit(subredditName: string): boolean {
  return subredditName.toLowerCase() === DEV_SUBREDDIT;
}

function itemText(item: Item): string {
  return item.kind === 'post'
    ? `${item.title} ${item.body} ${item.domain}`
    : `${item.postTitle} ${item.body}`;
}

function isTrainingRemovalCandidate(item: Item): boolean {
  const text = itemText(item).toLowerCase();
  const keywordHits = TRAINING_KEYWORDS.filter((keyword) => text.includes(keyword)).length;
  return keywordHits > 0 || (item.authorAccountAge <= 7 && item.authorCommentKarma <= 5);
}

function toModRemovalRecord(item: Item, moderator: string): ModRemovalRecord {
  return {
    id: item.id,
    kind: item.kind === 'post' ? 'post' : 'comment',
    title: item.kind === 'post' ? item.title : item.postTitle,
    body: item.body,
    author: item.author,
    authorId: item.authorId,
    authorCommentKarma: item.authorCommentKarma,
    authorPostKarma: item.authorPostKarma,
    authorAccountAge: item.authorAccountAge,
    authorIsMod: item.authorIsMod,
    authorIsGold: item.authorIsGold,
    moderator,
    removedAt: Date.now(),
    removalReason: 'Dev training removal',
    signalSource: 'resolved',
  };
}

// -- GET /api/ping - diagnostic --------------------------------------------

api.get('/ping', async (c) => {
  return c.json({
    subredditName: context.subredditName ?? 'none',
    username: context.username ?? 'none',
    itemsInMemory: store.items.length,
    fetchedAt: store.fetchedAt,
    historySubreddit: store.historySubreddit,
    historyDays: store.historyDays,
    fetchTest: 'ok',
  });
});

// -- GET /api/init ----------------------------------------------------------

api.get('/init', async (c) => {
  const llmApiKey = String((await settings.get('llmApiKey').catch(() => '')) ?? '').trim();
  const llmProvider = (String((await settings.get('llmProvider').catch(() => '')) ?? '').trim() || 'openai') as LlmProvider;
  const historyDays = await getHistoryDaysSetting();
  const subredditName = context.subredditName ?? '';
  const cachedHistory = subredditName
    ? await getCachedHistory(subredditName, historyDays)
    : null;
  const falsePositiveIds = subredditName ? await getFalsePositiveIds(subredditName) : [];
  return c.json<InitResponse>({
    subredditName,
    username: context.username ?? 'unknown',
    hasLlmKey: Boolean(llmApiKey),
    llmProvider,
    historyDays,
    cachedItemCount: cachedHistory?.items.length ?? 0,
    cachedAt: cachedHistory?.fetchedAt ?? null,
    falsePositiveIds,
  });
});

// -- POST /api/fetch-history ------------------------------------------------

api.post('/fetch-history', async (c) => {
  const body: FetchHistoryRequest = await c.req
    .json<FetchHistoryRequest>()
    .catch(() => ({ force: false }));
  const force = body.force ?? false;
  const sub = context.subredditName ?? '';
  if (!sub) return c.json<FetchHistoryResponse>({ status: 'error', message: 'No subreddit in context.' }, 400);

  try {
    const historyDays = await getHistoryDaysSetting();
    const history = await withRateLimitRetry(() => loadSandboxHistory(sub, historyDays, { force }), {
      attempts: 3,
    });
    console.log(
      `[fetch-history] loaded ${history.items.length} items for r/${sub} (${historyDays}d window, force=${force})`
    );
    return c.json<FetchHistoryResponse>({
      status: 'ok',
      items: history.items,
      totalFetched: history.items.length,
      fetchedAt: history.fetchedAt,
    });
  } catch (e) {
    console.error('[fetch-history] error:', e);
    return c.json<FetchHistoryResponse>({ status: 'error', message: formatUserError(e) }, 500);
  }
});

// -- POST /api/evaluate ----------------------------------------------------

api.post('/evaluate', async (c) => {
  const { yaml } = await c.req.json<EvaluateRequest>();
  let parsed;
  try {
    parsed = parseRules(yaml);
  } catch (e) {
    return c.json<EvaluateResponse>({ status: 'error', message: e instanceof ParseError ? e.message : `YAML error: ${String(e)}` }, 400);
  }
  if (parsed.rules.length === 0) {
    return c.json<EvaluateResponse>({ status: 'error', message: 'No rules found in YAML.' }, 400);
  }
  const sub = context.subredditName ?? '';
  if (!sub) {
    return c.json<EvaluateResponse>({ status: 'error', message: 'No subreddit in context.' }, 400);
  }
  try {
    const historyDays = await getHistoryDaysSetting();
    const history = await loadSandboxHistory(sub, historyDays);
    const summary = evaluateAll(parsed.rules, history.items);
    return c.json<EvaluateResponse>({
      status: 'ok',
      results: summary.results,
      evaluationMs: summary.evaluationMs,
      totalItems: history.items.length,
      warnings: parsed.warnings,
      unsupportedFields: parsed.unsupportedFields,
    });
  } catch (e) {
    return c.json<EvaluateResponse>({ status: 'error', message: formatError(e) }, 500);
  }
});

// -- POST /api/translate ---------------------------------------------------

api.post('/translate', async (c) => {
  const { description, feedback, currentYaml } = await c.req.json<TranslateRequest>();
  const apiKey = String((await settings.get('llmApiKey').catch(() => '')) ?? '').trim();
  const provider = (String((await settings.get('llmProvider').catch(() => '')) ?? '').trim() || 'openai') as LlmProvider;
  const SYSTEM = `You are an expert in Reddit's AutoModerator YAML syntax. Convert the user's plain-English description into valid AutoMod YAML using only this supported subset: type, action, action_reason, title, body, title+body, domain, author.{comment_karma,link_karma,account_age,name,flair_text,is_gold,is_moderator}, is_edited, and reports. Use author.link_karma for post karma. Output ONLY raw YAML, no markdown code blocks.`;
  if (!apiKey) {
    return c.json<TranslateResponse>(translateDescriptionLocally(description));
  }
  try {
    const userPrompt = feedback?.trim()
      ? [
          `Original moderator request:\n${description}`,
          currentYaml?.trim() ? `Current generated YAML:\n${currentYaml}` : '',
          `Moderator feedback to apply:\n${feedback}`,
          'Return the revised AutoModerator YAML only.',
        ].filter(Boolean).join('\n\n')
      : description;
    const result = await callLlm(
      { provider, apiKey },
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt }]
    );
    if (!result) throw new Error('LLM returned no response');
    const yaml = result.text.replace(/^```ya?ml\n?/m, '').replace(/\n?```$/m, '').trim();
    return c.json<TranslateResponse>({
      status: 'ok',
      yaml,
      reasoning: feedback?.trim()
        ? `Revised from moderator feedback: "${feedback.trim()}"`
        : `Translated from: "${description}"`,
      source: provider,
    });
  } catch {
    return c.json<TranslateResponse>(translateDescriptionLocally(description));
  }
});

// -- GET /api/live-rules ---------------------------------------------------

api.get('/live-rules', async (c) => {
  const sub = context.subredditName ?? '';
  if (!sub) {
    return c.json<LiveRulesResponse>({ status: 'error', message: 'No subreddit in context.' }, 400);
  }

  try {
    const live = await getLiveRuleState(sub);
    return c.json<LiveRulesResponse>({ status: 'ok', live });
  } catch (e) {
    return c.json<LiveRulesResponse>({ status: 'error', message: formatError(e) }, 500);
  }
});

// -- POST /api/live-rules/draft --------------------------------------------

api.post('/live-rules/draft', async (c) => {
  const sub = context.subredditName ?? '';
  if (!sub) {
    return c.json<SaveDraftResponse>({ status: 'error', message: 'No subreddit in context.' }, 400);
  }

  try {
    const { yaml } = await c.req.json<SaveDraftRequest>();
    const result = await saveLiveDraft(sub, yaml);
    return c.json<SaveDraftResponse>({
      status: 'ok',
      live: result.live,
      savedAt: result.savedAt,
      message: 'Draft saved to Reddit wiki page automod_studio_draft.',
    });
  } catch (e) {
    return c.json<SaveDraftResponse>({ status: 'error', message: formatError(e) }, 500);
  }
});

// -- POST /api/live-rules/apply --------------------------------------------

api.post('/live-rules/apply', async (c) => {
  const sub = context.subredditName ?? '';
  if (!sub) {
    return c.json<ApplyLiveRulesResponse>(
      { status: 'error', message: 'No subreddit in context.' },
      400
    );
  }

  try {
    const { yaml, mode } = await c.req.json<ApplyLiveRulesRequest>();
    const actor = context.username ?? 'unknown';
    const result = await applyLiveRules(
      sub,
      yaml,
      `AutoMod Sandbox apply by u/${actor}`,
      mode
    );
    return c.json<ApplyLiveRulesResponse>({
      status: 'ok',
      live: result.live,
      applied: result.applied,
      message: result.message,
    });
  } catch (e) {
    return c.json<ApplyLiveRulesResponse>({ status: 'error', message: formatError(e) }, 500);
  }
});

// -- POST /api/live-rules/rollback -----------------------------------------

api.post('/live-rules/rollback', async (c) => {
  const sub = context.subredditName ?? '';
  if (!sub) {
    return c.json<RollbackLiveRulesResponse>(
      { status: 'error', message: 'No subreddit in context.' },
      400
    );
  }

  try {
    const actor = context.username ?? 'unknown';
    const result = await rollbackLiveRules(sub, `AutoMod Sandbox rollback by u/${actor}`);
    return c.json<RollbackLiveRulesResponse>({
      status: 'ok',
      live: result.live,
      rolledBack: result.rolledBack,
      message: result.message,
    });
  } catch (e) {
    return c.json<RollbackLiveRulesResponse>({ status: 'error', message: formatError(e) }, 500);
  }
});

// -- GET /api/suggestions --------------------------------------------------

api.get('/suggestions', async (c) => {
  const sub = context.subredditName ?? '';
  if (!sub) return c.json<SuggestionsResponse>({ status: 'ok', suggestions: [] });

  try {
    const storedRemovals = await getModRemovalRecords(sub);
    const removals = filterRealRemovalRecords(storedRemovals);
    const hydrated: typeof removals = [];
    for (const record of removals) {
      hydrated.push(await withRateLimitRetry(() => hydrateRemovalRecord(sub, record)));
    }
    const cleanedHydrated = filterRealRemovalRecords(hydrated);
    if (
      JSON.stringify(cleanedHydrated) !== JSON.stringify(storedRemovals)
    ) {
      await writeModRemovalRecords(sub, cleanedHydrated);
    }
    if (cleanedHydrated.length < 5) return c.json<SuggestionsResponse>({ status: 'ok', suggestions: [] });

    const historyDays = await getHistoryDaysSetting();
    const history = await withRateLimitRetry(() => loadSandboxHistory(sub, historyDays));
    const falsePositiveIds = await getFalsePositiveIds(sub);
    const apiKey = String((await settings.get('llmApiKey').catch(() => '')) ?? '').trim();
    const provider = (String((await settings.get('llmProvider').catch(() => '')) ?? '').trim() || 'openai') as LlmProvider;
    const suggestions = await generateRuleSuggestions({
      apiKey: apiKey || undefined,
      provider,
      historyItems: history.items,
      removals: cleanedHydrated,
      falsePositiveIds,
    });
    return c.json<SuggestionsResponse>({ status: 'ok', suggestions });
  } catch (e) {
    return c.json<SuggestionsResponse>(
      { status: 'error', message: formatUserError(e), suggestions: [] },
      429
    );
  }
});

// -- POST /api/dev/remove-training-items -----------------------------------

api.post('/dev/remove-training-items', async (c) => {
  const sub = context.subredditName ?? '';
  if (!isDevSubreddit(sub)) {
    return c.json<DevRemoveTrainingItemsResponse>(
      {
        status: 'error',
        message: `Dev removals are only enabled in r/${DEV_SUBREDDIT}.`,
      },
      403
    );
  }

  try {
    const historyDays = await getHistoryDaysSetting();
    const history = await withRateLimitRetry(() => loadSandboxHistory(sub, historyDays));
    const existingRemovalIds = new Set((await getModRemovalRecords(sub)).map((record) => record.id));
    const candidates = history.items
      .filter((item) => !existingRemovalIds.has(item.id))
      .filter(isTrainingRemovalCandidate)
      .slice(0, 5);

    let removed = 0;
    for (const item of candidates) {
      await withRateLimitRetry(() => reddit.remove(item.id as RemovableThingId, false));
      await appendModRemovalRecord(
        sub,
        toModRemovalRecord(item, context.username ?? 'unknown')
      );
      removed += 1;
    }

    return c.json<DevRemoveTrainingItemsResponse>({
      status: 'ok',
      removed,
      candidates: candidates.length,
      message:
        removed > 0
          ? `Removed ${removed} real dev item${removed === 1 ? '' : 's'} and recorded them for suggestions.`
          : 'No matching dev items found to remove. Add posts or comments containing terms like telegram, discount, followers, promo, guaranteed, or offer, then run this again.',
    });
  } catch (e) {
    return c.json<DevRemoveTrainingItemsResponse>(
      { status: 'error', message: formatUserError(e) },
      500
    );
  }
});

// -- POST /api/suggestions/seed -------------------------------------------

api.post('/suggestions/seed', async (c) => {
  return c.json<SeedSuggestionsResponse>(
    {
      status: 'error',
      message: 'Test content generation is disabled. Suggestions now use real moderator removals only.',
    },
    410
  );
});

// -- POST /api/false-positive ----------------------------------------------

api.post('/false-positive', async (c) => {
  const { itemId } = await c.req.json<FalsePositiveRequest>();
  const sub = context.subredditName ?? '';
  if (!sub) {
    return c.json({ status: 'error', message: 'No subreddit in context.' }, 400);
  }

  await addFalsePositiveId(sub, itemId);
  return c.json({ status: 'ok' });
});

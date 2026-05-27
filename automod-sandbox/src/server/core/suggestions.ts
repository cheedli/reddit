import { evaluateAll } from '../../engine/evaluator.js';
import { parseRules } from '../../engine/parser.js';
import type { Comment, Item, ParseWarning, Post } from '../../engine/types.js';
import type { ModRemovalRecord, RuleSuggestion } from '../../shared/api.js';
import { buildRuleYaml } from './ruleBuilder.js';
import { callLlm } from './llm.js';
import type { LlmProvider } from './llm.js';
import { filterRealRemovalRecords } from './moderationMemory.js';

const STOP = new Set([
  'the',
  'a',
  'an',
  'is',
  'in',
  'it',
  'of',
  'to',
  'and',
  'or',
  'for',
  'with',
  'this',
  'that',
  'i',
  'my',
  'me',
  'we',
  'you',
  'he',
  'she',
  'they',
  'was',
  'are',
  'has',
  'have',
  'do',
  'be',
  'at',
  'on',
  'as',
  'by',
  'from',
  'not',
  'but',
  'so',
  'if',
  'its',
  'our',
  'your',
  'their',
]);

type SuggestionCandidate = {
  yaml: string;
  reasoning: string;
  source: RuleSuggestion['source'];
};

type CandidateScore = {
  score: number;
  suggestion: RuleSuggestion;
};

type LlmSuggestion = {
  yaml: string;
  reasoning: string;
};

type GenerateRuleSuggestionsOptions = {
  apiKey?: string;
  provider?: LlmProvider;
  fetchImpl?: typeof fetch;
  historyItems: Item[];
  removals: ModRemovalRecord[];
  falsePositiveIds: string[];
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dominantType(removals: ModRemovalRecord[]): 'submission' | 'comment' | 'any' {
  const comments = removals.filter((record) => record.kind === 'comment').length;
  const submissions = removals.length - comments;
  if (comments / removals.length >= 0.7) return 'comment';
  if (submissions / removals.length >= 0.7) return 'submission';
  return 'any';
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/\b[a-z][a-z0-9'-]{2,24}\b/g) ?? [];
}

function recordText(record: ModRemovalRecord): string {
  return `${record.title ?? ''} ${record.body}`.trim();
}

function itemText(item: Item): string {
  return item.kind === 'post' ? `${item.title} ${item.body}` : `${item.postTitle} ${item.body}`;
}

function toRemovalItem(record: ModRemovalRecord): Item {
  if (record.kind === 'post') {
    const item: Post = {
      kind: 'post',
      id: record.id,
      title: record.title ?? '',
      body: record.body,
      url: '',
      domain: '',
      author: record.author,
      authorId: record.authorId ?? '',
      authorCommentKarma: record.authorCommentKarma,
      authorPostKarma: record.authorPostKarma,
      authorAccountAge: record.authorAccountAge,
      authorIsMod: record.authorIsMod ?? false,
      authorIsGold: record.authorIsGold ?? false,
      authorFlairText: '',
      authorFlairCssClass: '',
      createdAt: record.removedAt,
      edited: false,
      flairText: '',
      flairCssClass: '',
      reports: 0,
      permalink: '',
    };
    return item;
  }

  const item: Comment = {
    kind: 'comment',
    id: record.id,
    body: record.body,
    author: record.author,
    authorId: record.authorId ?? '',
    authorCommentKarma: record.authorCommentKarma,
    authorPostKarma: record.authorPostKarma,
    authorAccountAge: record.authorAccountAge,
    authorIsMod: record.authorIsMod ?? false,
    authorIsGold: record.authorIsGold ?? false,
    authorFlairText: '',
    authorFlairCssClass: '',
    createdAt: record.removedAt,
    edited: false,
    flairText: '',
    flairCssClass: '',
    reports: 0,
    permalink: '',
    postTitle: record.title ?? '',
    postId: '',
  };
  return item;
}

function summarizeWarnings(warnings: ParseWarning[]): string[] {
  return warnings.slice(0, 3).map((warning) => warning.message);
}

function computeConfidence(
  estimatedPrecision: number,
  estimatedRecall: number,
  matchedFalsePositiveCount: number,
  warnings: ParseWarning[]
): RuleSuggestion['confidence'] {
  const riskyWarnings = warnings.some(
    (warning) =>
      warning.code === 'overly-broad-rule' ||
      warning.code === 'shadowed-rule' ||
      warning.code === 'missing-exception'
  );

  if (!riskyWarnings && matchedFalsePositiveCount === 0 && estimatedPrecision >= 0.75 && estimatedRecall >= 0.3) {
    return 'high';
  }
  if (!riskyWarnings && matchedFalsePositiveCount <= 1 && estimatedPrecision >= 0.45) {
    return 'medium';
  }
  return 'low';
}

function scoreCandidateSuggestion(
  suggestion: RuleSuggestion,
  warningCount: number
): number {
  return (
    suggestion.estimatedPrecision * 100 +
    suggestion.estimatedRecall * 60 -
    suggestion.nonRemovalMatchCount * 2 -
    suggestion.falsePositiveMatchCount * 10 -
    warningCount * 8
  );
}

function buildMetricsSuggestion(
  candidate: SuggestionCandidate,
  historyItems: Item[],
  removals: ModRemovalRecord[],
  falsePositiveIds: string[]
): CandidateScore | null {
  let parsed;
  try {
    parsed = parseRules(candidate.yaml);
  } catch {
    return null;
  }

  if (parsed.rules.length === 0 || parsed.unsupportedFields.length > 0) {
    return null;
  }

  const removalItems = removals.map(toRemovalItem);
  const historySummary = evaluateAll(parsed.rules, historyItems);
  const removalSummary = evaluateAll(parsed.rules, removalItems);
  const removalIds = new Set(removals.map((record) => record.id));
  const falsePositiveSet = new Set(falsePositiveIds);
  const matchedHistoryIds = new Set(historySummary.results.map((result) => result.item.id));
  const matchedRemovalIds = new Set(removalSummary.results.map((result) => result.item.id));

  if (matchedHistoryIds.size === 0) {
    return null;
  }

  const nonRemovalMatchCount = [...matchedHistoryIds].filter((id) => !removalIds.has(id)).length;
  const falsePositiveMatchCount = [...matchedHistoryIds].filter((id) => falsePositiveSet.has(id)).length;
  const estimatedPrecision =
    matchedRemovalIds.size + nonRemovalMatchCount === 0
      ? 0
      : matchedRemovalIds.size / (matchedRemovalIds.size + nonRemovalMatchCount);
  const estimatedRecall =
    removals.length === 0 ? 0 : matchedRemovalIds.size / removals.length;
  const confidence = computeConfidence(
    estimatedPrecision,
    estimatedRecall,
    falsePositiveMatchCount,
    parsed.warnings
  );

  const suggestion: RuleSuggestion = {
    id: `${candidate.source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    yaml: candidate.yaml,
    reasoning: candidate.reasoning,
    matchCount: matchedRemovalIds.size,
    totalRemovals: removals.length,
    historyMatchCount: matchedHistoryIds.size,
    nonRemovalMatchCount,
    falsePositiveMatchCount,
    estimatedPrecision,
    estimatedRecall,
    confidence,
    source: candidate.source,
    warningMessages: summarizeWarnings(parsed.warnings),
    exampleItems: removals
      .filter((record) => matchedRemovalIds.has(record.id))
      .slice(0, 3)
      .map((record) => ({
        title: record.title,
        body: record.body.slice(0, 150),
        author: record.author,
      })),
    createdAt: Date.now(),
  };

  return {
    score: scoreCandidateSuggestion(suggestion, parsed.warnings.length),
    suggestion,
  };
}

function buildKeywordRegex(words: string[]): string {
  const lookaheads = words.map((word) => `(?=.*\\b${escapeRegex(word)}\\b)`).join('');
  return `${lookaheads}.*`;
}

function findBestLessThanSignal(
  positiveValues: number[],
  negativeValues: number[],
  thresholds: number[]
): { threshold: number; positiveHits: number; negativeHits: number } | null {
  let best: { threshold: number; positiveHits: number; negativeHits: number; score: number } | null = null;

  for (const threshold of thresholds) {
    const positiveHits = positiveValues.filter((value) => value < threshold).length;
    const negativeHits = negativeValues.filter((value) => value < threshold).length;
    if (positiveHits < Math.max(2, Math.ceil(positiveValues.length * 0.25))) continue;

    const positiveRate = positiveValues.length === 0 ? 0 : positiveHits / positiveValues.length;
    const negativeRate = negativeValues.length === 0 ? 0 : negativeHits / negativeValues.length;
    const score = positiveRate - negativeRate;
    if (score <= 0.15) continue;

    if (!best || score > best.score) {
      best = { threshold, positiveHits, negativeHits, score };
    }
  }

  if (!best) return null;
  return {
    threshold: best.threshold,
    positiveHits: best.positiveHits,
    negativeHits: best.negativeHits,
  };
}

function generateHeuristicCandidates(
  historyItems: Item[],
  removals: ModRemovalRecord[],
  falsePositiveIds: string[]
): SuggestionCandidate[] {
  const candidates: SuggestionCandidate[] = [];
  const ruleType = dominantType(removals);
  const historyById = new Map(historyItems.map((item) => [item.id, item]));
  const falsePositiveItems = historyItems.filter((item) => falsePositiveIds.includes(item.id));
  const negativeHistory = historyItems.filter((item) => !removals.some((record) => record.id === item.id));
  const signalEligibleRemovals = removals.filter((record) => !record.synthetic);

  const positiveWordCounts = new Map<string, number>();
  const negativeWordCounts = new Map<string, number>();

  for (const removal of removals) {
    const seen = new Set<string>();
    for (const word of tokenize(recordText(removal))) {
      if (STOP.has(word) || seen.has(word)) continue;
      seen.add(word);
      positiveWordCounts.set(word, (positiveWordCounts.get(word) ?? 0) + 1);
    }
  }

  for (const item of falsePositiveItems) {
    const seen = new Set<string>();
    for (const word of tokenize(itemText(item))) {
      if (STOP.has(word) || seen.has(word)) continue;
      seen.add(word);
      negativeWordCounts.set(word, (negativeWordCounts.get(word) ?? 0) + 1);
    }
  }

  const keywordPool = [...positiveWordCounts.entries()]
    .map(([word, count]) => ({
      word,
      count,
      penalty: negativeWordCounts.get(word) ?? 0,
      score: count * 2 - (negativeWordCounts.get(word) ?? 0) * 3,
    }))
    .filter((entry) => entry.count >= Math.max(2, Math.ceil(removals.length * 0.25)) && entry.score > 0)
    .sort((left, right) => right.score - left.score || right.count - left.count)
    .slice(0, 4)
    .map((entry) => entry.word);

  if (keywordPool.length >= 2) {
    const words = keywordPool.slice(0, 2);
    candidates.push({
      source: 'heuristic',
      yaml: buildRuleYaml({
        type: ruleType,
        action: 'filter',
        actionReason: `Frequent manual-removal terms: ${words.join(', ')}`,
        textFields: [
          {
            name: ruleType === 'comment' ? 'body' : 'title+body',
            modifier: 'regex',
            values: [buildKeywordRegex(words)],
          },
        ],
      }),
      reasoning: `These terms co-occur across manual removals and are penalized when they also appear in known false positives.`,
    });
  }

  const removalAges = signalEligibleRemovals.map((record) => record.authorAccountAge);
  const negativeAges = negativeHistory.map((item) => item.authorAccountAge);
  const ageSignal = removalAges.length
    ? findBestLessThanSignal(removalAges, negativeAges, [1, 3, 7, 14, 30, 90])
    : null;
  if (ageSignal) {
    candidates.push({
      source: 'heuristic',
      yaml: buildRuleYaml({
        type: ruleType,
        action: 'filter',
        actionReason: `Manual removals skew toward accounts younger than ${ageSignal.threshold} days`,
        author: {
          accountAge: `< ${ageSignal.threshold} days`,
        },
      }),
      reasoning: `${ageSignal.positiveHits}/${signalEligibleRemovals.length} removals came from newer accounts, with much lower prevalence in recent history.`,
    });
  }

  const removalCommentKarma = signalEligibleRemovals.map((record) => record.authorCommentKarma);
  const negativeCommentKarma = negativeHistory.map((item) => item.authorCommentKarma);
  const commentKarmaSignal = removalCommentKarma.length
    ? findBestLessThanSignal(removalCommentKarma, negativeCommentKarma, [1, 5, 10, 25, 50])
    : null;
  if (commentKarmaSignal) {
    candidates.push({
      source: 'heuristic',
      yaml: buildRuleYaml({
        type: ruleType,
        action: 'filter',
        actionReason: `Manual removals skew toward authors under ${commentKarmaSignal.threshold} comment karma`,
        author: {
          commentKarma: `< ${commentKarmaSignal.threshold}`,
        },
      }),
      reasoning: `${commentKarmaSignal.positiveHits}/${signalEligibleRemovals.length} removals came from very low-comment-karma accounts.`,
    });
  }

  if (keywordPool.length >= 2 && ageSignal) {
    const words = keywordPool.slice(0, 2);
    candidates.push({
      source: 'heuristic',
      yaml: buildRuleYaml({
        type: ruleType,
        action: 'filter',
        actionReason: `Frequent removal terms from newer accounts`,
        textFields: [
          {
            name: ruleType === 'comment' ? 'body' : 'title+body',
            modifier: 'regex',
            values: [buildKeywordRegex(words)],
          },
        ],
        author: {
          accountAge: `< ${ageSignal.threshold} days`,
        },
      }),
      reasoning: `Combines the strongest text signal with the strongest account-age signal to trade recall for fewer false positives.`,
    });
  }

  for (const removal of removals) {
    const item = historyById.get(removal.id);
    if (!item || item.kind !== 'post' || !item.domain || item.domain.startsWith('self.')) continue;
    const domainHits = removals.filter((record) => historyById.get(record.id)?.kind === 'post' && (historyById.get(record.id) as Post | undefined)?.domain === item.domain).length;
    if (domainHits < 3) continue;

    candidates.push({
      source: 'heuristic',
      yaml: buildRuleYaml({
        type: 'submission',
        action: 'filter',
        actionReason: `Manual removals cluster on ${item.domain}`,
        textFields: [
          {
            name: 'domain',
            modifier: 'includes-word',
            values: [item.domain],
          },
        ],
      }),
      reasoning: `${domainHits}/${removals.length} removed submissions came from the same domain.`,
    });
    break;
  }

  return candidates;
}

async function generateLlmCandidates(
  apiKey: string,
  provider: LlmProvider,
  removals: ModRemovalRecord[],
  falsePositiveIds: string[],
  historyItems: Item[],
  fetchImpl: typeof fetch
): Promise<SuggestionCandidate[]> {
  const falsePositiveExamples = historyItems
    .filter((item) => falsePositiveIds.includes(item.id))
    .slice(0, 8)
    .map((item, index) => `${index + 1}. [${item.kind}] ${itemText(item).slice(0, 120)}`)
    .join('\n');

  const removalSummary = removals
    .slice(0, 25)
    .map(
      (record, index) =>
        `${index + 1}. [${record.kind}] ${recordText(record).slice(0, 120)} | ${
          record.synthetic
            ? 'seeded training example'
            : `author=${record.author} | age=${record.authorAccountAge}d | commentKarma=${record.authorCommentKarma} | postKarma=${record.authorPostKarma}`
        }`
    )
    .join('\n');

  const prompt = [
    'Write 1-3 candidate AutoModerator YAML rules using only this supported subset:',
    '- root fields: type, action, action_reason, title, body, title+body, domain, author, is_edited, reports',
    '- author fields: comment_karma, link_karma, account_age, name, flair_text, is_gold, is_moderator',
    '- use author.link_karma for post karma; do not output author.post_karma',
    '- text modifiers: includes-word, includes, starts-with, ends-with, full-exact, regex',
    '- avoid unsupported fields or syntax',
    '',
    `Positive examples (manual removals):\n${removalSummary}`,
    falsePositiveExamples
      ? `\nKnown false positives to avoid:\n${falsePositiveExamples}`
      : '',
    '',
    'Return JSON only in this shape:',
    '[{"yaml":"...","reasoning":"..."}]',
  ].join('\n');

  const result = await callLlm(
    { provider, apiKey, fetchImpl },
    [{ role: 'user', content: prompt }]
  );
  if (!result) return [];

  try {
    const content = result.text
      .replace(/^```json\n?/m, '')
      .replace(/\n?```$/m, '');
    const parsed = JSON.parse(content) as LlmSuggestion[];
    return parsed
      .filter(
        (entry): entry is LlmSuggestion =>
          Boolean(entry && typeof entry.yaml === 'string' && typeof entry.reasoning === 'string')
      )
      .map((entry) => ({
        yaml: entry.yaml.trim(),
        reasoning: entry.reasoning,
        source: provider,
      }));
  } catch {
    return [];
  }
}

export async function generateRuleSuggestions({
  apiKey,
  provider = 'openai',
  fetchImpl = fetch,
  historyItems,
  removals,
  falsePositiveIds,
}: GenerateRuleSuggestionsOptions): Promise<RuleSuggestion[]> {
  const realRemovals = filterRealRemovalRecords(removals);

  if (realRemovals.length < 5 || historyItems.length === 0) {
    return [];
  }

  const llmCandidates = apiKey
    ? await generateLlmCandidates(apiKey, provider, realRemovals, falsePositiveIds, historyItems, fetchImpl)
    : [];
  const heuristicCandidates = generateHeuristicCandidates(historyItems, realRemovals, falsePositiveIds);
  const seen = new Set<string>();
  const scored: CandidateScore[] = [];

  for (const candidate of [...llmCandidates, ...heuristicCandidates]) {
    const normalizedYaml = candidate.yaml.trim();
    if (!normalizedYaml || seen.has(normalizedYaml)) continue;
    seen.add(normalizedYaml);
    const score = buildMetricsSuggestion(
      { ...candidate, yaml: normalizedYaml },
      historyItems,
      realRemovals,
      falsePositiveIds
    );
    if (score) {
      scored.push(score);
    }
  }

  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.suggestion);
}

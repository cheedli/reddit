// Pure evaluation engine. No Devvit imports.
// evaluate(rules, items) → MatchResult[]

import type {
  EvaluationSummary,
  Item,
  MatchedCondition,
  MatchResult,
  ParsedRule,
} from './types.js';
import { matchAuthor } from './conditions/author.js';
import { matchMeta } from './conditions/meta.js';
import { findTextMatch, getExcerpt, matchText } from './conditions/text.js';

// Evaluate a single item against a single parsed rule.
export function evaluate(rule: ParsedRule, item: Item, ruleIndex: number): MatchResult {
  const matchedConditions: MatchedCondition[] = [];

  // --- type filter ---
  if (rule.type !== 'any') {
    const expectedKind = rule.type === 'submission' ? 'post' : 'comment';
    if (item.kind !== expectedKind) {
      return { matched: false, matchedConditions: [], action: null, item, ruleIndex };
    }
  }

  // --- title ---
  if (rule.title !== undefined) {
    const titleText = item.kind === 'post' ? item.title : item.postTitle;
    if (!matchText(rule.title, titleText)) {
      return { matched: false, matchedConditions: [], action: null, item, ruleIndex };
    }
    const firstMatch = findTextMatch(rule.title, titleText);
    matchedConditions.push(
      buildMatchedCondition(`title ${rule.title.modifier}`, firstMatch, titleText)
    );
  }

  // --- body ---
  if (rule.body !== undefined) {
    if (!matchText(rule.body, item.body)) {
      return { matched: false, matchedConditions: [], action: null, item, ruleIndex };
    }
    const firstMatch = findTextMatch(rule.body, item.body);
    matchedConditions.push(buildMatchedCondition(`body ${rule.body.modifier}`, firstMatch, item.body));
  }

  // --- title+body ---
  if (rule.titleAndBody !== undefined) {
    const titleText = item.kind === 'post' ? item.title : item.postTitle;
    const combined = titleText + ' ' + item.body;
    if (!matchText(rule.titleAndBody, combined)) {
      return { matched: false, matchedConditions: [], action: null, item, ruleIndex };
    }
    const firstMatch = findTextMatch(rule.titleAndBody, combined);
    matchedConditions.push(
      buildMatchedCondition(`title+body ${rule.titleAndBody.modifier}`, firstMatch, combined)
    );
  }

  // --- domain ---
  if (rule.domain !== undefined) {
    if (item.kind !== 'post') {
      return { matched: false, matchedConditions: [], action: null, item, ruleIndex };
    }
    if (!matchText(rule.domain, item.domain)) {
      return { matched: false, matchedConditions: [], action: null, item, ruleIndex };
    }
    matchedConditions.push({
      condition: `domain ${rule.domain.modifier}`,
      matchedValue: item.domain,
    });
  }

  // --- author block ---
  if (rule.author !== undefined) {
    const authorResult = matchAuthor(rule.author, item);
    if (!authorResult.matched) {
      return { matched: false, matchedConditions: [], action: null, item, ruleIndex };
    }
    for (const cond of authorResult.matchedConditions) {
      matchedConditions.push({ condition: cond });
    }
  }

  // --- meta conditions ---
  const metaResult = matchMeta(rule, item);
  if (!metaResult.matched) {
    return { matched: false, matchedConditions: [], action: null, item, ruleIndex };
  }
  for (const cond of metaResult.matchedConditions) {
    matchedConditions.push({ condition: cond });
  }

  // All conditions matched
  const result: MatchResult = {
    matched: true,
    matchedConditions,
    action: rule.action ?? null,
    item,
    ruleIndex,
  };

  if (rule.actionReason !== undefined) {
    result.actionReason = rule.actionReason;
  }

  return result;
}

// Evaluate all rules against all items and return a summary.
export function evaluateAll(rules: ParsedRule[], items: Item[]): EvaluationSummary {
  const start = Date.now();
  const results: MatchResult[] = [];

  for (const item of items) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule) continue;
      const result = evaluate(rule, item, i);
      if (result.matched) {
        results.push(result);
        // AutoMod stops at the first matching rule for an item (like CSS cascade)
        break;
      }
    }
  }

  return {
    totalItems: items.length,
    matchedItems: results.length,
    results,
    evaluationMs: Date.now() - start,
  };
}

function buildMatchedCondition(
  condition: string,
  matchedValue: string | undefined,
  sourceText?: string
): MatchedCondition {
  const matchedCondition: MatchedCondition = { condition };

  if (matchedValue !== undefined) {
    matchedCondition.matchedValue = matchedValue;
    if (sourceText) {
      matchedCondition.excerpt = getExcerpt(sourceText, matchedValue);
    }
  }

  return matchedCondition;
}

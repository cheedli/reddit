// Author condition evaluation. No Devvit imports.

import type { AuthorCondition, ComparisonValue, Item } from '../types.js';
import { matchText } from './text.js';

export function matchAuthor(
  condition: AuthorCondition,
  item: Item
): { matched: boolean; matchedConditions: string[] } {
  const matched: string[] = [];

  if (condition.commentKarma !== undefined) {
    if (!compareNumber(item.authorCommentKarma, condition.commentKarma)) {
      return { matched: false, matchedConditions: [] };
    }
    matched.push(`author comment_karma ${formatComparison(condition.commentKarma)}`);
  }

  if (condition.postKarma !== undefined) {
    if (!compareNumber(item.authorPostKarma, condition.postKarma)) {
      return { matched: false, matchedConditions: [] };
    }
    matched.push(`author post_karma ${formatComparison(condition.postKarma)}`);
  }

  if (condition.accountAge !== undefined) {
    if (!compareNumber(item.authorAccountAge, condition.accountAge)) {
      return { matched: false, matchedConditions: [] };
    }
    matched.push(`author account_age ${formatComparison(condition.accountAge)}`);
  }

  if (condition.isGold !== undefined) {
    if (item.authorIsGold !== condition.isGold) {
      return { matched: false, matchedConditions: [] };
    }
    matched.push(`author is_gold: ${String(condition.isGold)}`);
  }

  if (condition.isMod !== undefined) {
    if (item.authorIsMod !== condition.isMod) {
      return { matched: false, matchedConditions: [] };
    }
    matched.push(`author is_mod: ${String(condition.isMod)}`);
  }

  if (condition.name !== undefined) {
    if (!matchText(condition.name, item.author)) {
      return { matched: false, matchedConditions: [] };
    }
    matched.push(`author name matches`);
  }

  if (condition.flairText !== undefined) {
    if (!matchText(condition.flairText, item.authorFlairText)) {
      return { matched: false, matchedConditions: [] };
    }
    matched.push(`author flair_text matches`);
  }

  return { matched: true, matchedConditions: matched };
}

function compareNumber(actual: number, cmp: ComparisonValue): boolean {
  switch (cmp.operator) {
    case '<':  return actual < cmp.value;
    case '>':  return actual > cmp.value;
    case '<=': return actual <= cmp.value;
    case '>=': return actual >= cmp.value;
    case '=':  return actual === cmp.value;
  }
}

function formatComparison(cmp: ComparisonValue): string {
  return `${cmp.operator} ${cmp.value}${cmp.unit ? ' ' + cmp.unit : ''}`;
}

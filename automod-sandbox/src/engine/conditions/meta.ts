// Meta condition evaluation (domain, flair, reports, is_edited). No Devvit imports.

import type { Item, ParsedRule } from '../types.js';
import { matchText } from './text.js';

export interface MetaMatchResult {
  matched: boolean;
  matchedConditions: string[];
}

export function matchMeta(rule: ParsedRule, item: Item): MetaMatchResult {
  const matched: string[] = [];

  // domain only applies to posts (link posts)
  if (rule.domain !== undefined) {
    if (item.kind !== 'post') return { matched: false, matchedConditions: [] };
    if (!matchText(rule.domain, item.domain)) return { matched: false, matchedConditions: [] };
    const domainVal = rule.domain.values[0] ?? '';
    matched.push(`domain ${rule.domain.modifier} "${domainVal}"`);
  }

  if (rule.isEdited !== undefined) {
    if (item.edited !== rule.isEdited) return { matched: false, matchedConditions: [] };
    matched.push(`is_edited: ${String(rule.isEdited)}`);
  }

  if (rule.flairText !== undefined) {
    const flairTarget = item.flairText ?? '';
    if (!matchText(rule.flairText, flairTarget)) return { matched: false, matchedConditions: [] };
    matched.push(`flair_text matches`);
  }

  if (rule.flairCssClass !== undefined) {
    const cssTarget = item.flairCssClass ?? '';
    if (!matchText(rule.flairCssClass, cssTarget)) return { matched: false, matchedConditions: [] };
    matched.push(`flair_css_class matches`);
  }

  if (rule.reports !== undefined) {
    const { operator, value } = rule.reports;
    const reportCount = item.reports ?? 0;
    let pass = false;
    switch (operator) {
      case '<':  pass = reportCount < value; break;
      case '>':  pass = reportCount > value; break;
      case '<=': pass = reportCount <= value; break;
      case '>=': pass = reportCount >= value; break;
      case '=':  pass = reportCount === value; break;
    }
    if (!pass) return { matched: false, matchedConditions: [] };
    matched.push(`reports ${operator} ${value}`);
  }

  return { matched: true, matchedConditions: matched };
}

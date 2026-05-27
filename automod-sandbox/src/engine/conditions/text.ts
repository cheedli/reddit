// Text condition evaluation. No Devvit imports.

import type { TextCondition } from '../types.js';

export function matchText(condition: TextCondition, target: string): boolean {
  return findTextMatch(condition, target) !== undefined;
}

export function findTextMatch(condition: TextCondition, target: string): string | undefined {
  const { modifier, values, caseSensitive, excludes } = condition;

  for (const rawValue of values) {
    const matched = applyModifier(modifier, target, rawValue, caseSensitive);
    if (matched !== undefined) {
      // If any exclusion condition matches, the overall match fails
      if (excludes && excludes.some((excl) => findTextMatch(excl, target) !== undefined)) {
        return undefined;
      }
      return matched;
    }
  }

  return undefined;
}

function applyModifier(
  modifier: TextCondition['modifier'],
  target: string,
  rawValue: string,
  caseSensitive: boolean
): string | undefined {
  const text = caseSensitive ? target : target.toLowerCase();
  const value = caseSensitive ? rawValue : rawValue.toLowerCase();

  switch (modifier) {
    case 'includes': {
      const index = text.indexOf(value);
      return index === -1 ? undefined : target.slice(index, index + rawValue.length);
    }

    case 'includes-word':
      return includesWord(target, rawValue, caseSensitive);

    case 'starts-with':
      return text.startsWith(value) ? target.slice(0, rawValue.length) : undefined;

    case 'ends-with':
      return text.endsWith(value) ? target.slice(target.length - rawValue.length) : undefined;

    case 'full-exact':
      return text === value ? target : undefined;

    case 'regex':
      try {
        const match = new RegExp(rawValue, caseSensitive ? '' : 'i').exec(target);
        return match?.[0];
      } catch {
        return undefined;
      }
  }
}

function includesWord(text: string, rawWord: string, caseSensitive: boolean): string | undefined {
  const escaped = rawWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = caseSensitive ? 'g' : 'gi';
  const pattern = new RegExp(`(?:^|\\W)(${escaped})(?:\\W|$)`, flags);
  const match = pattern.exec(text);
  return match?.[1];
}

// Returns the excerpt around the first match (for UI display)
export function getExcerpt(text: string, matchValue: string, windowChars = 80): string {
  const idx = text.toLowerCase().indexOf(matchValue.toLowerCase());
  if (idx === -1) return text.slice(0, windowChars);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + matchValue.length + 50);
  const excerpt = text.slice(start, end);
  return (start > 0 ? '…' : '') + excerpt + (end < text.length ? '…' : '');
}

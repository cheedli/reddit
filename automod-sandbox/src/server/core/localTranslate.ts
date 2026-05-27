import type { TranslateResponse } from '../../shared/api.js';
import { buildRuleYaml } from './ruleBuilder.js';
import type { DraftedTextField } from './ruleBuilder.js';

const DOMAIN_RE = /\b(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i;
const QUOTED_VALUE_RE = /"([^"]+)"/g;

function pickAction(description: string): 'remove' | 'filter' | 'report' | 'approve' {
  if (/\bapprove\b/i.test(description)) return 'approve';
  if (/\breport\b/i.test(description)) return 'report';
  if (/\bremove\b/i.test(description)) return 'remove';
  return 'filter';
}

function pickType(description: string): 'comment' | 'submission' | 'any' {
  if (/\bcomments?\b/i.test(description)) return 'comment';
  if (/\b(posts?|submissions?|links?)\b/i.test(description)) return 'submission';
  return 'any';
}

function extractKeywords(description: string): string[] {
  const quoted = [...description.matchAll(QUOTED_VALUE_RE)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
  if (quoted.length > 0) return [...new Set(quoted)];

  const clauseMatch = description.match(
    /\b(?:contains?|containing|include|including|with)\b(.+?)(?:$|\bfrom\b|\bthat\b|\bwhich\b)/
  );
  if (!clauseMatch?.[1]) return [];

  return clauseMatch[1]
    .split(/\bor\b|\band\b|,/i)
    .map((value) => value.trim().replace(/^["']|["']$/g, ''))
    .filter((value) => value.length >= 3 && /^[a-z0-9 .'-]+$/i.test(value))
    .slice(0, 4);
}

function extractDomain(description: string): string | null {
  return description.match(/\b(?:links?\s+to|linking\s+to|domain)\s+([a-z0-9.-]+\.[a-z]{2,})/i)?.[1]
    ?? description.match(DOMAIN_RE)?.[1]
    ?? null;
}

function extractThreshold(
  description: string,
  phrases: string[],
  unit = ''
): { operator: '<' | '>'; value: number } | null {
  for (const phrase of phrases) {
    const lessMatch = description.match(
      new RegExp(`\\b(?:younger than|under|below|less than|fewer than)\\s+(\\d+)\\s+${phrase}`, 'i')
    );
    if (lessMatch?.[1]) {
      return { operator: '<', value: Number(lessMatch[1]) };
    }

    const greaterMatch = description.match(
      new RegExp(`\\b(?:older than|over|above|more than|at least)\\s+(\\d+)\\s+${phrase}`, 'i')
    );
    if (greaterMatch?.[1]) {
      return { operator: '>', value: Number(greaterMatch[1]) };
    }
  }

  if (!unit) return null;

  const genericLess = description.match(
    new RegExp(`\\b(?:under|below|less than|fewer than)\\s+(\\d+)\\s+${unit}`, 'i')
  );
  if (genericLess?.[1]) {
    return { operator: '<', value: Number(genericLess[1]) };
  }

  const genericGreater = description.match(
    new RegExp(`\\b(?:over|above|more than|at least)\\s+(\\d+)\\s+${unit}`, 'i')
  );
  if (genericGreater?.[1]) {
    return { operator: '>', value: Number(genericGreater[1]) };
  }

  return null;
}

function formatComparison(operator: '<' | '>', value: number, suffix = ''): string {
  return `${operator} ${value}${suffix}`;
}

export function translateDescriptionLocally(description: string): TranslateResponse {
  const action = pickAction(description);
  const type = pickType(description);
  const keywords = extractKeywords(description);
  const domain = extractDomain(description);
  const age = extractThreshold(description, ['days?', 'day-old accounts?', 'day accounts?'], 'days?');
  const commentKarma = extractThreshold(
    description,
    ['comment karma', 'karma'],
    'karma'
  );
  const postKarma = extractThreshold(description, ['post karma', 'link karma']);
  const reports = extractThreshold(description, ['reports?'], 'reports?');
  const isEdited = /\bedited\b/i.test(description);

  const textField: DraftedTextField | null =
    keywords.length > 0
      ? {
          name: type === 'comment' ? 'body' : 'title+body',
          modifier: 'includes-word' as const,
          values: keywords,
        }
      : null;

  if (!textField && !domain && !age && !commentKarma && !postKarma && !reports && !isEdited) {
    return {
      status: 'error',
      message:
        'Local translation supports keywords, domains, account age, karma, edited state, and reports. Try one of the examples or add quoted keywords.',
    };
  }

  const yaml = buildRuleYaml({
    type,
    action,
    actionReason: 'Built from local template mode',
    textFields: [
      ...(textField ? [textField] : []),
      ...(domain
        ? [
            {
              name: 'domain' as const,
              modifier: 'includes-word' as const,
              values: [domain],
            },
          ]
        : []),
    ],
    author: {
      commentKarma: commentKarma ? formatComparison(commentKarma.operator, commentKarma.value) : undefined,
      postKarma: postKarma ? formatComparison(postKarma.operator, postKarma.value) : undefined,
      accountAge: age ? formatComparison(age.operator, age.value, ' days') : undefined,
    },
    isEdited: isEdited || undefined,
    reports: reports ? formatComparison(reports.operator, reports.value) : undefined,
  });

  return {
    status: 'ok',
    yaml,
    reasoning:
      'Generated with the built-in template parser. It handles the common moderation patterns this app can safely support without an OpenAI key.',
    source: 'template',
  };
}

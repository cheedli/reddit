// YAML → ParsedRule[] parser. No Devvit imports.
// Reference: https://support.reddithelp.com/hc/en-us/articles/15484574206484-Automoderator

import yaml from 'js-yaml';
import type {
  Action,
  AuthorCondition,
  ComparisonOperator,
  ComparisonValue,
  ParseResult,
  ParseWarning,
  ParsedRule,
  ParsedTextField,
  TextCondition,
  TextModifier,
} from './types.js';

const SUPPORTED_ROOT_FIELDS = new Set([
  'type',
  'action',
  'action_reason',
  'reason',
  'title',
  'body',
  'title+body',
  'domain',
  'flair_text',
  'link_flair_text',
  'flair_css_class',
  'link_flair_css_class',
  'author',
  'is_edited',
  'reports',
]);

const SUPPORTED_AUTHOR_FIELDS = new Set([
  'comment_karma',
  'post_karma',
  'link_karma',
  'account_age',
  'name',
  'flair_text',
  'is_gold',
  'is_moderator',
  'is_mod',
]);

const SUPPORTED_TEXT_MODIFIERS: TextModifier[] = [
  'includes-word',
  'includes',
  'starts-with',
  'ends-with',
  'full-exact',
  'regex',
];

const TEXT_MODIFIER_ALIASES: Record<string, TextModifier> = {
  includes_word: 'includes-word',
  starts_with: 'starts-with',
  ends_with: 'ends-with',
  full_exact: 'full-exact',
};

const TEXT_METADATA_KEYS = new Set(['case_sensitive', 'value']);

type RuleParseResult = {
  rule: ParsedRule;
  warnings: ParseWarning[];
  unsupportedFields: string[];
};

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly ruleIndex: number
  ) {
    super(`Rule ${ruleIndex + 1}: ${message}`);
    this.name = 'ParseError';
  }
}

// AutoMod separates rules with ---
export function parseRules(yamlContent: string): ParseResult {
  const sections = yamlContent.split(/^---$/m).filter((s) => s.trim().length > 0);
  const rules: ParsedRule[] = [];
  const warnings: ParseWarning[] = [];
  const unsupportedFields = new Set<string>();

  for (const [index, section] of sections.entries()) {
    const result = parseRule(section.trim(), index);
    rules.push(result.rule);
    warnings.push(...result.warnings);
    for (const field of result.unsupportedFields) {
      unsupportedFields.add(field);
    }
  }

  warnings.push(...analyzeRuleInteractions(rules));

  return {
    rules,
    warnings: sortWarnings(warnings),
    unsupportedFields: [...unsupportedFields].sort(),
  };
}

function parseRule(rawYaml: string, index: number): RuleParseResult {
  let raw: unknown;
  try {
    raw = yaml.load(rawYaml);
  } catch (error) {
    throw new ParseError(`Invalid YAML: ${String(error)}`, index);
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ParseError('Rule must be a YAML mapping', index);
  }

  const doc = raw as Record<string, unknown>;
  const warnings: ParseWarning[] = [];
  const unsupportedFields = new Set<string>();
  const rule: ParsedRule = { type: 'any', rawYaml };

  for (const key of Object.keys(doc)) {
    if (!SUPPORTED_ROOT_FIELDS.has(key)) {
      addWarning(
        warnings,
        index,
        'unsupported-field',
        `Unsupported top-level field "${key}" is ignored by the sandbox.`,
        key
      );
      unsupportedFields.add(key);
    }
  }

  const typeVal = doc['type'];
  if (typeVal !== undefined) {
    const type = String(typeVal).toLowerCase();
    if (type === 'submission' || type === 'link' || type === 'self') {
      rule.type = 'submission';
    } else if (type === 'comment') {
      rule.type = 'comment';
    } else if (type !== 'any') {
      addWarning(
        warnings,
        index,
        'unknown-type',
        `Unknown type "${typeVal}" defaults to "any".`,
        'type'
      );
    }
  }

  const actionVal = doc['action'];
  if (actionVal !== undefined) {
    const action = String(actionVal).toLowerCase();
    if (action === 'remove' || action === 'filter' || action === 'report' || action === 'approve') {
      rule.action = action as Action;
    } else {
      addWarning(
        warnings,
        index,
        'unknown-action',
        `Unknown action "${actionVal}" is ignored.`,
        'action'
      );
    }
  }

  const reasonVal = doc['action_reason'] ?? doc['reason'];
  if (reasonVal !== undefined) {
    rule.actionReason = String(reasonVal);
  }

  const title = parseTextField(doc, 'title', index, warnings, unsupportedFields);
  if (title) rule.title = title;

  const body = parseTextField(doc, 'body', index, warnings, unsupportedFields);
  if (body) rule.body = body;

  const titleAndBody = parseTextField(doc, 'title+body', index, warnings, unsupportedFields);
  if (titleAndBody) rule.titleAndBody = titleAndBody;

  const domain = parseTextField(doc, 'domain', index, warnings, unsupportedFields);
  if (domain) rule.domain = domain;

  const flairText =
    parseTextField(doc, 'flair_text', index, warnings, unsupportedFields) ??
    parseTextField(doc, 'link_flair_text', index, warnings, unsupportedFields);
  if (flairText) rule.flairText = flairText;

  const flairCssClass =
    parseTextField(doc, 'flair_css_class', index, warnings, unsupportedFields) ??
    parseTextField(doc, 'link_flair_css_class', index, warnings, unsupportedFields);
  if (flairCssClass) rule.flairCssClass = flairCssClass;

  if ('author' in doc) {
    const authorBlock = doc['author'];
    if (authorBlock !== null && typeof authorBlock === 'object' && !Array.isArray(authorBlock)) {
      rule.author = parseAuthorBlock(
        authorBlock as Record<string, unknown>,
        index,
        warnings,
        unsupportedFields
      );
    } else {
      addWarning(
        warnings,
        index,
        'unsupported-field',
        'The author field must be a YAML mapping.',
        'author'
      );
      unsupportedFields.add('author');
    }
  }

  if ('is_edited' in doc) {
    rule.isEdited = Boolean(doc['is_edited']);
  }

  if ('reports' in doc) {
    const reports = parseComparison(String(doc['reports']));
    if (reports) {
      rule.reports = reports;
    } else {
      addWarning(
        warnings,
        index,
        'unsupported-field',
        `Could not parse reports comparison "${String(doc['reports'])}".`,
        'reports'
      );
      unsupportedFields.add('reports');
    }
  }

  warnings.push(...analyzeRuleBreadth(rule, index));

  return {
    rule,
    warnings,
    unsupportedFields: [...unsupportedFields].sort(),
  };
}

function parseTextField(
  doc: Record<string, unknown>,
  key: string,
  ruleIndex: number,
  warnings: ParseWarning[],
  unsupportedFields: Set<string>
): TextCondition | undefined {
  if (!(key in doc)) return undefined;
  return parseTextConditionValue(doc[key], key, ruleIndex, warnings, unsupportedFields)?.condition;
}

function parseTextConditionValue(
  value: unknown,
  fieldPath: string,
  ruleIndex: number,
  warnings: ParseWarning[],
  unsupportedFields: Set<string>
): ParsedTextField | undefined {
  if (typeof value === 'string' || Array.isArray(value)) {
    const values = extractStringArray(value);
    if (values.length === 0) {
      addWarning(
        warnings,
        ruleIndex,
        'empty-text-condition',
        `Field "${fieldPath}" has no string values to match.`,
        fieldPath
      );
    }
    return {
      condition: {
        modifier: 'includes-word',
        values,
        caseSensitive: false,
      },
      unsupportedKeys: [],
      hasExplicitModifier: false,
    };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    addWarning(
      warnings,
      ruleIndex,
      'unsupported-field',
      `Field "${fieldPath}" must be a string, list, or mapping.`,
      fieldPath
    );
    unsupportedFields.add(fieldPath);
    return undefined;
  }

  const block = value as Record<string, unknown>;
  const modifierKeys = findModifierKeys(block);
  const modifierKey = modifierKeys[0];
  const unsupportedKeys: string[] = [];

  const isNegatedModifier = (key: string): boolean => {
    if (!key.startsWith('~')) return false;
    const base = key.slice(1);
    return (
      SUPPORTED_TEXT_MODIFIERS.includes(base as TextModifier) ||
      base in TEXT_MODIFIER_ALIASES
    );
  };

  for (const key of Object.keys(block)) {
    if (
      !TEXT_METADATA_KEYS.has(key) &&
      !SUPPORTED_TEXT_MODIFIERS.includes(key as TextModifier) &&
      !(key in TEXT_MODIFIER_ALIASES) &&
      !isNegatedModifier(key)
    ) {
      unsupportedKeys.push(key);
      addWarning(
        warnings,
        ruleIndex,
        'unsupported-text-modifier',
        `Unsupported text modifier "${key}" in "${fieldPath}" is ignored.`,
        `${fieldPath}.${key}`
      );
      unsupportedFields.add(`${fieldPath}.${key}`);
    }
  }

  if (modifierKeys.length > 1) {
    for (const key of modifierKeys.slice(1)) {
      addWarning(
        warnings,
        ruleIndex,
        'unsupported-text-modifier',
        `Multiple modifiers were provided for "${fieldPath}". Only "${modifierKey?.key ?? 'value'}" is used; "${key.key}" is ignored.`,
        `${fieldPath}.${key.key}`
      );
      unsupportedFields.add(`${fieldPath}.${key.key}`);
      unsupportedKeys.push(key.key);
    }
  }

  const modifier = modifierKey?.modifier ?? 'includes-word';
  const valuesSource = modifierKey ? block[modifierKey.key] : block['value'];
  const values = extractStringArray(valuesSource ?? []);
  const caseSensitive = Boolean(block['case_sensitive'] ?? false);

  if (values.length === 0) {
    addWarning(
      warnings,
      ruleIndex,
      'empty-text-condition',
      `Field "${fieldPath}" has no string values to match.`,
      fieldPath
    );
  }

  if (modifier === 'regex') {
    for (const regexStr of values) {
      try {
        new RegExp(regexStr);
      } catch {
        addWarning(
          warnings,
          ruleIndex,
          'invalid-regex',
          `Invalid regex "${regexStr}" in field "${fieldPath}" will never match.`,
          fieldPath
        );
      }
    }
  }

  const negatedKeys = findNegatedModifierKeys(block);
  const excludes: TextCondition[] = [];

  for (const { key, modifier: negModifier } of negatedKeys) {
    const negValues = extractStringArray(block[key] ?? []);
    if (negValues.length > 0) {
      excludes.push({
        modifier: negModifier,
        values: negValues,
        caseSensitive,
      });
    }
  }

  const condition: TextCondition = { modifier, values, caseSensitive };
  if (excludes.length > 0) {
    condition.excludes = excludes;
  }

  return {
    condition,
    unsupportedKeys,
    hasExplicitModifier: Boolean(modifierKey),
  };
}

function findModifierKeys(
  block: Record<string, unknown>
): Array<{ key: string; modifier: TextModifier }> {
  const found: Array<{ key: string; modifier: TextModifier }> = [];

  for (const modifier of SUPPORTED_TEXT_MODIFIERS) {
    if (modifier in block) {
      found.push({ key: modifier, modifier });
    }
  }

  for (const [key, modifier] of Object.entries(TEXT_MODIFIER_ALIASES)) {
    if (key in block) {
      found.push({ key, modifier });
    }
  }

  return found;
}

function findNegatedModifierKeys(
  block: Record<string, unknown>
): Array<{ key: string; modifier: TextModifier }> {
  const found: Array<{ key: string; modifier: TextModifier }> = [];

  for (const modifier of SUPPORTED_TEXT_MODIFIERS) {
    const negKey = `~${modifier}`;
    if (negKey in block) {
      found.push({ key: negKey, modifier });
    }
  }

  for (const [alias, modifier] of Object.entries(TEXT_MODIFIER_ALIASES)) {
    const negKey = `~${alias}`;
    if (negKey in block) {
      found.push({ key: negKey, modifier });
    }
  }

  return found;
}

function extractStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function parseAuthorBlock(
  block: Record<string, unknown>,
  ruleIndex: number,
  warnings: ParseWarning[],
  unsupportedFields: Set<string>
): AuthorCondition {
  const author: AuthorCondition = {};

  for (const key of Object.keys(block)) {
    if (!SUPPORTED_AUTHOR_FIELDS.has(key)) {
      addWarning(
        warnings,
        ruleIndex,
        'unsupported-author-field',
        `Unsupported author field "${key}" is ignored.`,
        `author.${key}`
      );
      unsupportedFields.add(`author.${key}`);
    }
  }

  const commentKarma = block['comment_karma'];
  if (commentKarma !== undefined) {
    const comparison = parseComparison(String(commentKarma));
    if (comparison) {
      author.commentKarma = comparison;
    }
  }

  const postKarma = block['post_karma'] ?? block['link_karma'];
  if (postKarma !== undefined) {
    const comparison = parseComparison(String(postKarma));
    if (comparison) {
      author.postKarma = comparison;
    }
  }

  const accountAge = block['account_age'];
  if (accountAge !== undefined) {
    const comparison = parseAgeComparison(String(accountAge));
    if (comparison) {
      author.accountAge = comparison;
    }
  }

  if (block['name'] !== undefined) {
    const name = parseTextConditionValue(
      block['name'],
      'author.name',
      ruleIndex,
      warnings,
      unsupportedFields
    );
    if (name) {
      author.name = name.condition;
    }
  }

  if (block['flair_text'] !== undefined) {
    const flairText = parseTextConditionValue(
      block['flair_text'],
      'author.flair_text',
      ruleIndex,
      warnings,
      unsupportedFields
    );
    if (flairText) {
      author.flairText = flairText.condition;
    }
  }

  const isGold = block['is_gold'];
  if (isGold !== undefined) {
    author.isGold = Boolean(isGold);
  }

  const isMod = block['is_moderator'] ?? block['is_mod'];
  if (isMod !== undefined) {
    author.isMod = Boolean(isMod);
  }

  return author;
}

function parseComparison(raw: string): ComparisonValue | undefined {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([<>]=?|=)\s*(\d+(?:\.\d+)?)/);
  if (!match) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? { operator: '=', value: numeric } : undefined;
  }

  return {
    operator: match[1] as ComparisonOperator,
    value: Number(match[2]),
  };
}

function parseAgeComparison(raw: string): ComparisonValue | undefined {
  const trimmed = raw.trim().toLowerCase();
  const match = trimmed.match(/^([<>]=?|=)\s*(\d+(?:\.\d+)?)\s*(days?|months?|years?|hours?)?/);
  if (!match) return undefined;

  let value = Number(match[2]);
  const singularUnit = (match[3] ?? 'days').replace(/s$/, '');

  if (singularUnit === 'month') value *= 30;
  if (singularUnit === 'year') value *= 365;
  if (singularUnit === 'hour') value /= 24;

  return {
    operator: match[1] as ComparisonOperator,
    value,
    unit:
      singularUnit === 'month'
        ? 'months'
        : singularUnit === 'year'
          ? 'years'
          : singularUnit === 'hour'
            ? 'hours'
            : 'days',
  };
}

function analyzeRuleBreadth(rule: ParsedRule, ruleIndex: number): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  const conditionCount = countConditions(rule);
  const textOnlyRule =
    conditionCount > 0 &&
    countTextConditions(rule) === conditionCount &&
    !hasAuthorSignalConditions(rule) &&
    rule.type === 'any';

  if (conditionCount === 0) {
    warnings.push({
      ruleIndex,
      code: 'empty-rule',
      message: 'This rule has no supported match conditions and will apply to every item.',
    });
    warnings.push({
      ruleIndex,
      code: 'overly-broad-rule',
      message: 'This rule is extremely broad. Add narrowing conditions before trusting it.',
    });
    return warnings;
  }

  if (textOnlyRule) {
    warnings.push({
      ruleIndex,
      code: 'overly-broad-rule',
      message: 'This rule relies only on broad text matches across all items. Review its historical match set carefully.',
    });
  }

  if (requiresExceptionWarning(rule)) {
    warnings.push({
      ruleIndex,
      code: 'missing-exception',
      message: 'This destructive rule has no obvious narrowing exception or secondary signal. Consider adding an allowlist or another condition.',
    });
  }

  return warnings;
}

function analyzeRuleInteractions(rules: ParsedRule[]): ParseWarning[] {
  const warnings: ParseWarning[] = [];

  for (let laterIndex = 1; laterIndex < rules.length; laterIndex++) {
    const laterRule = rules[laterIndex];
    if (!laterRule) continue;

    for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex++) {
      const earlierRule = rules[earlierIndex];
      if (!earlierRule) continue;

      if (isShadowedByEarlierRule(earlierRule, laterRule)) {
        warnings.push({
          ruleIndex: laterIndex,
          code: 'shadowed-rule',
          message: `Rule ${laterIndex + 1} is shadowed by rule ${earlierIndex + 1} and will never run for items that match its supported conditions.`,
        });
        break;
      }
    }
  }

  return warnings;
}

function isShadowedByEarlierRule(earlierRule: ParsedRule, laterRule: ParsedRule): boolean {
  if (earlierRule.type !== 'any' && earlierRule.type !== laterRule.type) {
    return false;
  }

  const comparableKeys: Array<keyof ParsedRule> = [
    'title',
    'body',
    'titleAndBody',
    'domain',
    'author',
    'isEdited',
    'flairText',
    'flairCssClass',
    'reports',
  ];

  let hasConstraint = false;

  for (const key of comparableKeys) {
    const earlierValue = earlierRule[key];
    if (earlierValue === undefined) continue;
    hasConstraint = true;

    const laterValue = laterRule[key];
    if (!isDeepEqual(earlierValue, laterValue)) {
      return false;
    }
  }

  if (!hasConstraint) {
    return false;
  }

  return countConditions(earlierRule) <= countConditions(laterRule);
}

function countConditions(rule: ParsedRule): number {
  let count = rule.type === 'any' ? 0 : 1;

  if (rule.title) count++;
  if (rule.body) count++;
  if (rule.titleAndBody) count++;
  if (rule.domain) count++;
  if (rule.isEdited !== undefined) count++;
  if (rule.flairText) count++;
  if (rule.flairCssClass) count++;
  if (rule.reports) count++;

  if (rule.author) {
    if (rule.author.commentKarma) count++;
    if (rule.author.postKarma) count++;
    if (rule.author.accountAge) count++;
    if (rule.author.name) count++;
    if (rule.author.flairText) count++;
    if (rule.author.isGold !== undefined) count++;
    if (rule.author.isMod !== undefined) count++;
  }

  return count;
}

function countTextConditions(rule: ParsedRule): number {
  let count = 0;

  if (rule.title) count++;
  if (rule.body) count++;
  if (rule.titleAndBody) count++;
  if (rule.domain) count++;
  if (rule.flairText) count++;
  if (rule.flairCssClass) count++;
  if (rule.author?.name) count++;
  if (rule.author?.flairText) count++;

  return count;
}

function hasAuthorSignalConditions(rule: ParsedRule): boolean {
  return Boolean(
    rule.author?.commentKarma ||
      rule.author?.postKarma ||
      rule.author?.accountAge ||
      rule.author?.isGold !== undefined ||
      rule.author?.isMod !== undefined
  );
}

function requiresExceptionWarning(rule: ParsedRule): boolean {
  if (rule.action !== 'remove' && rule.action !== 'filter') {
    return false;
  }

  const destructiveTextOnly =
    countTextConditions(rule) === countConditions(rule) &&
    !hasAuthorSignalConditions(rule) &&
    rule.reports === undefined &&
    rule.isEdited === undefined;

  if (!destructiveTextOnly) {
    return false;
  }

  const hasNegation = [
    rule.title,
    rule.body,
    rule.titleAndBody,
    rule.domain,
    rule.flairText,
    rule.flairCssClass,
    rule.author?.name,
    rule.author?.flairText,
  ].some((cond) => cond?.excludes && cond.excludes.length > 0);

  if (hasNegation) {
    return false;
  }

  const textValues = [
    ...(rule.title?.values ?? []),
    ...(rule.body?.values ?? []),
    ...(rule.titleAndBody?.values ?? []),
    ...(rule.domain?.values ?? []),
    ...(rule.flairText?.values ?? []),
    ...(rule.flairCssClass?.values ?? []),
    ...(rule.author?.name?.values ?? []),
    ...(rule.author?.flairText?.values ?? []),
  ];

  return textValues.length > 0;
}

function addWarning(
  warnings: ParseWarning[],
  ruleIndex: number,
  code: ParseWarning['code'],
  message: string,
  field?: string
): void {
  const warning: ParseWarning = { ruleIndex, code, message };
  if (field !== undefined) {
    warning.field = field;
  }
  warnings.push(warning);
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortWarnings(warnings: ParseWarning[]): ParseWarning[] {
  return [...warnings].sort((left, right) => {
    if (left.ruleIndex !== right.ruleIndex) return left.ruleIndex - right.ruleIndex;
    return left.message.localeCompare(right.message);
  });
}

export const DEFAULT_YAML = `# AutoMod Sandbox — starter rule
# Edit this YAML to test different conditions against your sub's posts and comments.
# Separate multiple rules with --- on its own line.
#
# Reference: https://support.reddithelp.com/hc/en-us/articles/15484574206484-Automoderator

type: submission
title:
  includes-word:
    - spam
    - scam
    - "buy now"
action: remove
action_reason: Matched spam keywords in title
`;

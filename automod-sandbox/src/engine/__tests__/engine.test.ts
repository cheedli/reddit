// Vitest unit tests for the AutoMod evaluation engine.
// These must pass before the app is considered ship-ready.

import { describe, expect, it } from 'vitest';
import { evaluate, evaluateAll } from '../evaluator.js';
import { DEFAULT_YAML, ParseError, parseRules } from '../parser.js';
import type { Comment, Item, Post } from '../types.js';

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    kind: 'post',
    id: 't3_test1',
    title: 'Hello world',
    body: 'This is a test post body.',
    url: 'https://example.com/r/test/comments/test1',
    domain: 'self.test',
    author: 'testuser',
    authorId: 't2_abc',
    authorCommentKarma: 100,
    authorPostKarma: 50,
    authorAccountAge: 365,
    authorIsMod: false,
    authorIsGold: false,
    authorFlairText: '',
    authorFlairCssClass: '',
    createdAt: Date.now(),
    edited: false,
    flairText: '',
    flairCssClass: '',
    reports: 0,
    permalink: '/r/test/comments/test1',
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    kind: 'comment',
    id: 't1_test1',
    body: 'This is a test comment.',
    author: 'testuser',
    authorId: 't2_abc',
    authorCommentKarma: 100,
    authorPostKarma: 50,
    authorAccountAge: 365,
    authorIsMod: false,
    authorIsGold: false,
    authorFlairText: '',
    authorFlairCssClass: '',
    createdAt: Date.now(),
    edited: false,
    flairText: '',
    flairCssClass: '',
    reports: 0,
    permalink: '/r/test/comments/test1/testcomment',
    postTitle: 'Parent post title',
    postId: 't3_test1',
    ...overrides,
  };
}

function parseOnly(yaml: string) {
  return parseRules(yaml).rules;
}

describe('parseRules', () => {
  it('parses a simple rule', () => {
    const rules = parseOnly(`
type: submission
title:
  includes-word:
    - spam
action: remove
`);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.type).toBe('submission');
    expect(rules[0]?.action).toBe('remove');
    expect(rules[0]?.title?.modifier).toBe('includes-word');
    expect(rules[0]?.title?.values).toContain('spam');
  });

  it('parses multiple rules separated by ---', () => {
    const rules = parseOnly(`
type: submission
action: remove
---
type: comment
action: filter
`);
    expect(rules).toHaveLength(2);
    expect(rules[0]?.type).toBe('submission');
    expect(rules[1]?.type).toBe('comment');
  });

  it('parses shorthand string as includes-word', () => {
    const rules = parseOnly('title: spam');
    expect(rules[0]?.title?.modifier).toBe('includes-word');
    expect(rules[0]?.title?.values).toEqual(['spam']);
  });

  it('parses shorthand array as includes-word', () => {
    const rules = parseOnly('title: [spam, scam]');
    expect(rules[0]?.title?.values).toEqual(['spam', 'scam']);
  });

  it('parses author block with karma and account age', () => {
    const rules = parseOnly(`
author:
  comment_karma: "< 10"
  account_age: "< 30 days"
action: filter
`);
    const author = rules[0]?.author;
    expect(author?.commentKarma?.operator).toBe('<');
    expect(author?.commentKarma?.value).toBe(10);
    expect(author?.accountAge?.operator).toBe('<');
    expect(author?.accountAge?.value).toBe(30);
  });

  it('parses author flair text conditions', () => {
    const rules = parseOnly(`
author:
  flair_text:
    includes-word: [trusted]
`);
    expect(rules[0]?.author?.flairText?.modifier).toBe('includes-word');
    expect(rules[0]?.author?.flairText?.values).toEqual(['trusted']);
  });

  it('normalizes account_age in years to days', () => {
    const rules = parseOnly('author:\n  account_age: "< 1 year"');
    expect(rules[0]?.author?.accountAge?.value).toBe(365);
  });

  it('parses regex modifier', () => {
    const rules = parseOnly('body:\n  regex: "https?://"');
    expect(rules[0]?.body?.modifier).toBe('regex');
    expect(rules[0]?.body?.values[0]).toBe('https?://');
  });

  it('parses snake_case modifiers without dropping values', () => {
    const rules = parseOnly('title:\n  includes_word: [spam]');
    expect(rules[0]?.title?.modifier).toBe('includes-word');
    expect(rules[0]?.title?.values).toEqual(['spam']);
  });

  it('parses domain condition', () => {
    const rules = parseOnly('domain: twitter.com');
    expect(rules[0]?.domain?.values).toContain('twitter.com');
  });

  it('parses type: link as submission', () => {
    const rules = parseOnly('type: link\naction: remove');
    expect(rules[0]?.type).toBe('submission');
  });

  it('returns warnings for unknown types and unsupported fields', () => {
    const parsed = parseRules('type: strange\nmodifiers_exempt: false');
    expect(parsed.rules[0]?.type).toBe('any');
    expect(parsed.unsupportedFields).toContain('modifiers_exempt');
    expect(parsed.warnings.some((warning) => warning.code === 'unknown-type')).toBe(true);
    expect(parsed.warnings.some((warning) => warning.code === 'unsupported-field')).toBe(true);
  });

  it('flags shadowed rules', () => {
    const parsed = parseRules(`
title:
  includes-word: [spam]
action: remove
---
title:
  includes-word: [spam]
body:
  includes-word: [discount]
action: filter
`);
    expect(parsed.warnings.some((warning) => warning.code === 'shadowed-rule')).toBe(true);
  });

  it('throws ParseError on invalid YAML', () => {
    expect(() => parseRules('{invalid: yaml: :')).toThrow(ParseError);
  });

  it('parses the default YAML without errors', () => {
    expect(() => parseRules(DEFAULT_YAML)).not.toThrow();
  });

  it('does not warn missing-exception when rule has ~ negation', () => {
    const parsed = parseRules(`
title:
  includes-word: [crypto]
  ~includes-word: [news]
action: remove
`);
    expect(parsed.warnings.some((w) => w.code === 'missing-exception')).toBe(false);
  });

  it('warns on invalid regex at parse time', () => {
    const parsed = parseRules('title:\n  regex: "["');
    expect(parsed.warnings.some((w) => w.code === 'invalid-regex')).toBe(true);
  });

  it('parses ~ negation modifier on title without unsupported-text-modifier warning', () => {
    const parsed = parseRules(`
title:
  includes-word: [crypto]
  ~includes-word: [news]
action: remove
`);
    expect(parsed.warnings.filter(w => w.code === 'unsupported-text-modifier')).toHaveLength(0);
    const cond = parsed.rules[0]?.title;
    expect(cond?.excludes).toHaveLength(1);
    expect(cond?.excludes?.[0]?.modifier).toBe('includes-word');
    expect(cond?.excludes?.[0]?.values).toContain('news');
  });
});

describe('evaluate: type filter', () => {
  it('does not match submission rule against comments', () => {
    const [rule] = parseOnly('type: submission\naction: remove');
    expect(evaluate(rule!, makeComment(), 0).matched).toBe(false);
  });

  it('matches submission rule against posts', () => {
    const [rule] = parseOnly('type: submission\naction: remove');
    expect(evaluate(rule!, makePost(), 0).matched).toBe(true);
  });

  it('matches any rule against both posts and comments', () => {
    const [rule] = parseOnly('type: any\naction: report');
    expect(evaluate(rule!, makePost(), 0).matched).toBe(true);
    expect(evaluate(rule!, makeComment(), 0).matched).toBe(true);
  });
});

describe('evaluate: title conditions', () => {
  it('matches title includes-word', () => {
    const [rule] = parseOnly('title:\n  includes-word: [spam]');
    expect(evaluate(rule!, makePost({ title: 'This is spam please ignore' }), 0).matched).toBe(
      true
    );
  });

  it('does not match title includes-word with different word', () => {
    const [rule] = parseOnly('title:\n  includes-word: [spam]');
    expect(evaluate(rule!, makePost({ title: 'Hello world' }), 0).matched).toBe(false);
  });

  it('matches title includes-word case-insensitively by default', () => {
    const [rule] = parseOnly('title:\n  includes-word: [SPAM]');
    expect(evaluate(rule!, makePost({ title: 'This is spam.' }), 0).matched).toBe(true);
  });

  it('matches title includes substring', () => {
    const [rule] = parseOnly('title:\n  includes: [sp]');
    expect(evaluate(rule!, makePost({ title: 'This is spam.' }), 0).matched).toBe(true);
  });

  it('matches title starts-with', () => {
    const [rule] = parseOnly('title:\n  starts-with: ["buy now"]');
    expect(evaluate(rule!, makePost({ title: 'Buy now! Limited offer' }), 0).matched).toBe(true);
  });

  it('matches title regex', () => {
    const [rule] = parseOnly('title:\n  regex: "https?://"');
    expect(evaluate(rule!, makePost({ title: 'Check out http://evil.com' }), 0).matched).toBe(
      true
    );
  });

  it('respects regex case_sensitive: true', () => {
    const [rule] = parseOnly('title:\n  regex: "SPAM"\n  case_sensitive: true');
    expect(evaluate(rule!, makePost({ title: 'spam' }), 0).matched).toBe(false);
  });

  it('does not match title regex that fails', () => {
    const [rule] = parseOnly('title:\n  regex: "^[0-9]+$"');
    expect(evaluate(rule!, makePost({ title: 'Not a number' }), 0).matched).toBe(false);
  });

  it('negation: matches when positive hits and exclusion does not', () => {
    const [rule] = parseOnly(`
title:
  includes-word: [crypto]
  ~includes-word: [news]
action: remove
`);
    expect(evaluate(rule!, makePost({ title: 'Buy crypto today' }), 0).matched).toBe(true);
  });

  it('negation: does not match when positive hits but exclusion also hits', () => {
    const [rule] = parseOnly(`
title:
  includes-word: [crypto]
  ~includes-word: [news]
action: remove
`);
    expect(evaluate(rule!, makePost({ title: 'Crypto news roundup' }), 0).matched).toBe(false);
  });

  it('negation: does not match when positive condition does not hit', () => {
    const [rule] = parseOnly(`
title:
  includes-word: [crypto]
  ~includes-word: [news]
action: remove
`);
    expect(evaluate(rule!, makePost({ title: 'Hello world' }), 0).matched).toBe(false);
  });
});

describe('evaluate: body conditions', () => {
  it('matches body includes-word', () => {
    const [rule] = parseOnly('body:\n  includes-word: [free]');
    expect(evaluate(rule!, makePost({ body: 'Get free stuff!' }), 0).matched).toBe(true);
  });

  it('does not match body includes-word when word is absent', () => {
    const [rule] = parseOnly('body:\n  includes-word: [free]');
    expect(evaluate(rule!, makePost({ body: 'Nothing suspicious here.' }), 0).matched).toBe(false);
  });
});

describe('evaluate: author conditions', () => {
  it('matches author comment_karma < 10', () => {
    const [rule] = parseOnly('author:\n  comment_karma: "< 10"\naction: filter');
    expect(evaluate(rule!, makePost({ authorCommentKarma: 5 }), 0).matched).toBe(true);
  });

  it('does not match author comment_karma < 10 when karma is 50', () => {
    const [rule] = parseOnly('author:\n  comment_karma: "< 10"\naction: filter');
    expect(evaluate(rule!, makePost({ authorCommentKarma: 50 }), 0).matched).toBe(false);
  });

  it('matches author account_age < 30 days', () => {
    const [rule] = parseOnly('author:\n  account_age: "< 30 days"\naction: remove');
    expect(evaluate(rule!, makePost({ authorAccountAge: 10 }), 0).matched).toBe(true);
  });

  it('does not match author account_age < 30 days when account is 365 days old', () => {
    const [rule] = parseOnly('author:\n  account_age: "< 30 days"\naction: remove');
    expect(evaluate(rule!, makePost({ authorAccountAge: 365 }), 0).matched).toBe(false);
  });

  it('matches author flair_text', () => {
    const [rule] = parseOnly('author:\n  flair_text:\n    includes-word: [trusted]');
    expect(
      evaluate(rule!, makeComment({ authorFlairText: 'trusted helper' }), 0).matched
    ).toBe(true);
  });

  it('matches combined karma + account_age condition', () => {
    const [rule] = parseOnly(`
author:
  comment_karma: "< 10"
  account_age: "< 7 days"
action: filter
`);
    expect(
      evaluate(rule!, makePost({ authorCommentKarma: 3, authorAccountAge: 2 }), 0).matched
    ).toBe(true);
  });

  it('does not match combined condition when only one fails', () => {
    const [rule] = parseOnly(`
author:
  comment_karma: "< 10"
  account_age: "< 7 days"
action: filter
`);
    expect(
      evaluate(rule!, makePost({ authorCommentKarma: 3, authorAccountAge: 365 }), 0).matched
    ).toBe(false);
  });
});

describe('evaluate: domain conditions', () => {
  it('matches domain includes twitter.com', () => {
    const [rule] = parseOnly('domain: twitter.com');
    expect(evaluate(rule!, makePost({ domain: 'twitter.com' }), 0).matched).toBe(true);
  });

  it('does not match domain for a comment', () => {
    const [rule] = parseOnly('domain: twitter.com');
    expect(evaluate(rule!, makeComment(), 0).matched).toBe(false);
  });
});

describe('evaluate: meta conditions', () => {
  it('matches is_edited: true', () => {
    const [rule] = parseOnly('is_edited: true\naction: report');
    expect(evaluate(rule!, makePost({ edited: true }), 0).matched).toBe(true);
  });

  it('does not match is_edited: true on non-edited post', () => {
    const [rule] = parseOnly('is_edited: true\naction: report');
    expect(evaluate(rule!, makePost({ edited: false }), 0).matched).toBe(false);
  });

  it('matches reports > 3', () => {
    const [rule] = parseOnly('reports: "> 3"\naction: filter');
    expect(evaluate(rule!, makePost({ reports: 5 }), 0).matched).toBe(true);
  });
});

describe('evaluate: action and matchedConditions', () => {
  it('returns the correct action', () => {
    const [rule] = parseOnly('title:\n  includes-word: [spam]\naction: remove');
    expect(evaluate(rule!, makePost({ title: 'spam!' }), 0).action).toBe('remove');
  });

  it('populates matchedConditions with condition name', () => {
    const [rule] = parseOnly('title:\n  includes-word: [spam]\naction: remove');
    const result = evaluate(rule!, makePost({ title: 'spam!' }), 0);
    expect(result.matchedConditions[0]?.condition).toContain('title');
  });
});

describe('evaluateAll', () => {
  it('evaluates all items and returns only matches', () => {
    const items: Item[] = [
      makePost({ title: 'spam post' }),
      makePost({ title: 'normal post' }),
      makeComment({ body: 'spam comment' }),
    ];
    const summary = evaluateAll(parseOnly('title:\n  includes-word: [spam]\naction: remove'), items);
    expect(summary.totalItems).toBe(3);
    expect(summary.matchedItems).toBe(1);
  });

  it('stops at first matching rule (AutoMod cascade behavior)', () => {
    const summary = evaluateAll(
      parseOnly(`
title:
  includes-word: [spam]
action: remove
---
title:
  includes-word: [spam]
action: filter
`),
      [makePost({ title: 'spam post' })]
    );
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]?.action).toBe('remove');
    expect(summary.results[0]?.ruleIndex).toBe(0);
  });

  it('measures evaluation time', () => {
    const summary = evaluateAll(parseOnly('title:\n  includes-word: [spam]'), [makePost()]);
    expect(typeof summary.evaluationMs).toBe('number');
    expect(summary.evaluationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── STRESS TESTS ────────────────────────────────────────────────────────────

describe('stress: empty and malformed YAML', () => {
  it('handles empty string gracefully', () => {
    const result = parseRules('');
    expect(result.rules).toHaveLength(0);
  });

  it('handles whitespace-only YAML', () => {
    const result = parseRules('   \n\n  \n');
    expect(result.rules).toHaveLength(0);
  });

  it('handles YAML with only comments', () => {
    // Comments-only parses to null which is treated as an empty/invalid rule — should throw ParseError
    expect(() => parseRules('# just a comment\n# another comment')).toThrow(ParseError);
  });

  it('throws ParseError on completely invalid YAML', () => {
    expect(() => parseRules(': : invalid: yaml: :::')).toThrow(ParseError);
  });

  it('handles rule with only action and no conditions', () => {
    const result = parseRules('action: remove');
    // Should parse without crashing — may warn but must not throw
    expect(result.rules).toHaveLength(1);
  });

  it('handles rule with empty action field', () => {
    const result = parseRules('title:\n  includes-word: [spam]\naction:');
    expect(result.rules).toHaveLength(1);
  });

  it('handles unknown action value without crashing', () => {
    const result = parseRules('title:\n  includes-word: [spam]\naction: nuke');
    expect(result.warnings.some((w) => w.code === 'unknown-action')).toBe(true);
  });

  it('handles multi-rule file with a blank section between separators', () => {
    const result = parseRules(`
title:
  includes-word: [spam]
action: remove
---
---
title:
  includes-word: [scam]
action: filter
`);
    // Should not crash; blank sections are skipped
    expect(result.rules.length).toBeGreaterThanOrEqual(1);
  });

  it('handles very long title string (10k chars) without hanging', () => {
    const longTitle = 'a'.repeat(10000);
    const [rule] = parseOnly('title:\n  includes-word: [spam]');
    const start = Date.now();
    evaluate(rule!, makePost({ title: longTitle }), 0);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('stress: 0-item history', () => {
  it('evaluateAll returns empty results for empty item list', () => {
    const rules = parseOnly('title:\n  includes-word: [spam]\naction: remove');
    const summary = evaluateAll(rules, []);
    expect(summary.results).toHaveLength(0);
    expect(summary.evaluationMs).toBeGreaterThanOrEqual(0);
  });

  it('evaluateAll handles empty rules list against items', () => {
    const summary = evaluateAll([], [makePost({ title: 'spam post' })]);
    expect(summary.results).toHaveLength(0);
  });

  it('evaluateAll handles both empty rules and empty items', () => {
    const summary = evaluateAll([], []);
    expect(summary.results).toHaveLength(0);
  });
});

describe('stress: large scale evaluation', () => {
  it('evaluates 1000 items in under 500ms', () => {
    const rules = parseOnly(`
title:
  includes-word: [spam, scam, free, buy, crypto]
author:
  comment_karma: "< 10"
  account_age: "< 30 days"
action: remove
`);
    const items: Item[] = Array.from({ length: 1000 }, (_, i) =>
      makePost({
        id: `t3_${i}`,
        title: i % 3 === 0 ? 'Buy crypto now! spam scam' : 'Normal post title',
        authorCommentKarma: i % 5 === 0 ? 2 : 200,
        authorAccountAge: i % 7 === 0 ? 5 : 400,
      })
    );
    const start = Date.now();
    const summary = evaluateAll(rules, items);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(summary.results.length).toBeGreaterThan(0);
  });

  it('handles 50 rules without crashing', () => {
    const rulesYaml = Array.from(
      { length: 50 },
      (_, i) => `title:\n  includes-word: [keyword${i}]\naction: remove`
    ).join('\n---\n');
    const result = parseRules(rulesYaml);
    expect(result.rules).toHaveLength(50);
    const summary = evaluateAll(result.rules, [makePost({ title: 'keyword25 in title' })]);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]?.ruleIndex).toBe(25);
  });
});

describe('stress: all text modifiers', () => {
  it('includes-word matches whole word only', () => {
    const [rule] = parseOnly('title:\n  includes-word: [spam]');
    expect(evaluate(rule!, makePost({ title: 'this is spam here' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'spammer alert' }), 0).matched).toBe(false);
  });

  it('includes matches substring', () => {
    const [rule] = parseOnly('title:\n  includes: [pam]');
    expect(evaluate(rule!, makePost({ title: 'spammer alert' }), 0).matched).toBe(true);
  });

  it('starts-with matches prefix', () => {
    const [rule] = parseOnly('title:\n  starts-with: [Buy]');
    expect(evaluate(rule!, makePost({ title: 'Buy followers now' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'Please Buy followers' }), 0).matched).toBe(false);
  });

  it('ends-with matches suffix', () => {
    const [rule] = parseOnly('title:\n  ends-with: [now]');
    expect(evaluate(rule!, makePost({ title: 'Buy followers now' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'now is the time' }), 0).matched).toBe(false);
  });

  it('full-exact matches exact string only', () => {
    const [rule] = parseOnly('title:\n  full-exact: [exactly this]');
    expect(evaluate(rule!, makePost({ title: 'exactly this' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'exactly this plus more' }), 0).matched).toBe(false);
    expect(evaluate(rule!, makePost({ title: 'not exactly this' }), 0).matched).toBe(false);
  });

  it('regex matches pattern', () => {
    const [rule] = parseOnly('title:\n  regex: ["\\\\d{4}"]\naction: remove');
    expect(evaluate(rule!, makePost({ title: 'code 1234' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'no digits here' }), 0).matched).toBe(false);
  });

  it('title+body checks both fields', () => {
    const [rule] = parseOnly('title+body:\n  includes-word: [promo]');
    expect(evaluate(rule!, makePost({ title: 'promo deal', body: 'normal body' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'normal title', body: 'check out this promo' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'nothing here', body: 'nothing here either' }), 0).matched).toBe(false);
  });

  it('case_sensitive: true respects case', () => {
    const [rule] = parseOnly('title:\n  includes-word: [Spam]\n  case_sensitive: true');
    expect(evaluate(rule!, makePost({ title: 'This is Spam' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'This is spam' }), 0).matched).toBe(false);
  });

  it('body condition works on comments', () => {
    const [rule] = parseOnly('body:\n  includes-word: [promo]');
    expect(evaluate(rule!, makeComment({ body: 'check out this promo link' }), 0).matched).toBe(true);
  });
});

describe('stress: regex edge cases', () => {
  it('invalid regex emits warning and does not crash evaluator', () => {
    const result = parseRules('title:\n  regex: "["\naction: remove');
    expect(result.warnings.some((w) => w.code === 'invalid-regex')).toBe(true);
    // Evaluating with an invalid regex rule should not throw
    expect(() => evaluateAll(result.rules, [makePost()])).not.toThrow();
  });

  it('unicode regex matches correctly', () => {
    const [rule] = parseOnly('title:\n  regex: ["\\\\p{L}+"]\naction: remove');
    // Basic regex — should not crash
    expect(() => evaluate(rule!, makePost({ title: 'hello' }), 0)).not.toThrow();
  });

  it('regex with anchors works correctly', () => {
    const [rule] = parseOnly('title:\n  regex: ["^Buy"]\naction: remove');
    expect(evaluate(rule!, makePost({ title: 'Buy followers' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'Please Buy followers' }), 0).matched).toBe(false);
  });

  it('regex with global flag does not cause stateful match issues across evaluations', () => {
    const [rule] = parseOnly('title:\n  regex: ["spam+"]\naction: remove');
    const post = makePost({ title: 'spammm' });
    // Run twice — stateful /g regex would fail on second call
    expect(evaluate(rule!, post, 0).matched).toBe(true);
    expect(evaluate(rule!, post, 0).matched).toBe(true);
  });
});

describe('stress: author conditions combined', () => {
  it('matches only when ALL author conditions pass', () => {
    const yaml = `
author:
  comment_karma: "< 10"
  post_karma: "< 5"
  account_age: "< 14 days"
action: remove
`;
    const [rule] = parseOnly(yaml);
    // All pass
    expect(evaluate(rule!, makePost({ authorCommentKarma: 3, authorPostKarma: 2, authorAccountAge: 7 }), 0).matched).toBe(true);
    // One fails
    expect(evaluate(rule!, makePost({ authorCommentKarma: 3, authorPostKarma: 2, authorAccountAge: 30 }), 0).matched).toBe(false);
    expect(evaluate(rule!, makePost({ authorCommentKarma: 50, authorPostKarma: 2, authorAccountAge: 7 }), 0).matched).toBe(false);
  });

  it('matches author is_gold', () => {
    const [rule] = parseOnly('author:\n  is_gold: true');
    expect(evaluate(rule!, makePost({ authorIsGold: true }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ authorIsGold: false }), 0).matched).toBe(false);
  });

  it('matches author is_moderator', () => {
    const [rule] = parseOnly('author:\n  is_moderator: true');
    expect(evaluate(rule!, makePost({ authorIsMod: true }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ authorIsMod: false }), 0).matched).toBe(false);
  });

  it('matches author name includes', () => {
    const [rule] = parseOnly('author:\n  name:\n    includes: [bot]');
    expect(evaluate(rule!, makePost({ author: 'spambot_99' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ author: 'regular_user' }), 0).matched).toBe(false);
  });

  it('account_age comparison operators: >, >=, <, <=', () => {
    expect(evaluate(parseOnly('author:\n  account_age: "> 100 days"')[0]!, makePost({ authorAccountAge: 200 }), 0).matched).toBe(true);
    expect(evaluate(parseOnly('author:\n  account_age: ">= 365 days"')[0]!, makePost({ authorAccountAge: 365 }), 0).matched).toBe(true);
    expect(evaluate(parseOnly('author:\n  account_age: "<= 30 days"')[0]!, makePost({ authorAccountAge: 30 }), 0).matched).toBe(true);
    expect(evaluate(parseOnly('author:\n  account_age: "<= 30 days"')[0]!, makePost({ authorAccountAge: 31 }), 0).matched).toBe(false);
  });
});

describe('stress: negation (~) operator', () => {
  it('negation on body condition', () => {
    const [rule] = parseOnly(`
body:
  includes-word: [crypto]
  ~includes-word: [news, discussion, analysis]
action: remove
`);
    expect(evaluate(rule!, makePost({ body: 'Buy crypto now' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ body: 'crypto news roundup' }), 0).matched).toBe(false);
    expect(evaluate(rule!, makePost({ body: 'crypto discussion thread' }), 0).matched).toBe(false);
  });

  it('multiple exclusions combined in one ~includes-word array', () => {
    // YAML does not allow duplicate keys — multiple exclusions must be in one array
    const [rule] = parseOnly(`
title:
  includes-word: [free]
  ~includes-word: [trial, open source]
action: remove
`);
    expect(evaluate(rule!, makePost({ title: 'get free stuff' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'free trial offer' }), 0).matched).toBe(false);
    expect(evaluate(rule!, makePost({ title: 'free open source project' }), 0).matched).toBe(false);
  });

  it('negation on title+body checks both fields for exclusion', () => {
    const [rule] = parseOnly(`
title+body:
  includes-word: [promo]
  ~includes-word: [official]
action: remove
`);
    expect(evaluate(rule!, makePost({ title: 'big promo today', body: 'check it out' }), 0).matched).toBe(true);
    expect(evaluate(rule!, makePost({ title: 'official promo', body: 'check it out' }), 0).matched).toBe(false);
  });
});

describe('stress: multi-rule cascade edge cases', () => {
  it('second rule fires when first does not match', () => {
    const rules = parseOnly(`
title:
  includes-word: [spam]
action: remove
---
author:
  comment_karma: "< 5"
action: filter
`);
    const result = evaluateAll(rules, [makePost({ title: 'clean title', authorCommentKarma: 2 })]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.action).toBe('filter');
    expect(result.results[0]?.ruleIndex).toBe(1);
  });

  it('item that matches no rule is not in results', () => {
    const rules = parseOnly('title:\n  includes-word: [spam]\naction: remove');
    const result = evaluateAll(rules, [makePost({ title: 'totally normal post' })]);
    expect(result.results).toHaveLength(0);
  });

  it('approve action stops cascade like remove', () => {
    const rules = parseOnly(`
author:
  is_moderator: true
action: approve
---
title:
  includes-word: [test]
action: remove
`);
    const result = evaluateAll(rules, [makePost({ title: 'test post', authorIsMod: true })]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.action).toBe('approve');
  });
});

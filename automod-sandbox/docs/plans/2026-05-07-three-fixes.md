# Three Pre-Upload Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three gaps before hackathon upload: (1) negation/exception support for the `~` operator, (2) cache-key correctness confirmation + test, (3) regex validation at parse time with a clear error warning.

**Architecture:** All changes are confined to `src/engine/` (parser, text condition evaluator, types). No Devvit or server code changes needed. All fixes are covered by new Vitest unit tests in the existing `engine.test.ts` file.

**Tech Stack:** TypeScript, Vitest, js-yaml (already installed). Run tests with `npm test` from the project root.

---

## Fix 1 — Regex Validation at Parse Time

AutoMod rules with invalid regex (e.g. `title: regex: "["`) currently produce no parse error — they silently return no match at evaluation time. We should catch invalid regex during parsing and emit a `ParseWarning` with a new code `'invalid-regex'`.

### Task 1: Add `invalid-regex` warning code to types

**Files:**
- Modify: `src/engine/types.ts:80`

**Step 1: Write the failing test**

Add this test to `src/engine/__tests__/engine.test.ts` inside the `describe('parseRules', ...)` block:

```ts
it('warns on invalid regex at parse time', () => {
  const parsed = parseRules('title:\n  regex: "["');
  expect(parsed.warnings.some((w) => w.code === 'invalid-regex')).toBe(true);
});
```

**Step 2: Run it to confirm it fails**

```bash
npm test -- --reporter=verbose 2>&1 | grep -A3 "invalid regex"
```
Expected: FAIL — `invalid-regex` is not a known warning code yet.

**Step 3: Add the new warning code to the union type**

In `src/engine/types.ts`, find the `ParseWarning` interface `code` union (line ~72) and add `'invalid-regex'`:

```ts
  code:
    | 'empty-rule'
    | 'empty-text-condition'
    | 'invalid-regex'          // ← add this line
    | 'missing-exception'
    | 'overly-broad-rule'
    | 'shadowed-rule'
    | 'unknown-action'
    | 'unknown-type'
    | 'unsupported-author-field'
    | 'unsupported-field'
    | 'unsupported-text-modifier';
```

**Step 4: Validate regex in the parser**

In `src/engine/parser.ts`, find the `parseTextConditionValue` function. After the modifier and values are extracted (around line 340), add a regex validation block before the `return` statement:

```ts
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
```

**Step 5: Run tests**

```bash
npm test
```
Expected: All tests pass including the new one.

**Step 6: Commit**

```bash
git add src/engine/types.ts src/engine/parser.ts src/engine/__tests__/engine.test.ts
git commit -m "feat(engine): warn on invalid regex at parse time"
```

---

## Fix 2 — Cache Key Correctness Verification

The audit flagged that `historyKey(subredditName)` doesn't include `historyDays` in the Redis key, so changing the day range might serve stale data. After reading the code, the cache payload *does* include `historyDays` and `getCachedHistory` rejects payloads where `cached.historyDays !== historyDays` (line 190 of `history.ts`). The bug doesn't exist — but there's no test proving this invariant. We add one.

**Files:**
- Test: `src/engine/__tests__/engine.test.ts` (no server test infra needed — we test the *logic* separately via a pure helper extracted in the next step)

Since `history.ts` imports Devvit APIs, we can't unit-test it directly. Instead we add a note in code + a comment confirming the invariant so it isn't accidentally broken.

**Step 1: Add a guarding comment to `getCachedHistory`**

In `src/server/core/history.ts`, find line 190:

```ts
    if (cached.historyDays !== historyDays) {
      return null;
    }
```

Add a one-line comment above it:

```ts
    // Reject cache hits from a different day-range setting to avoid stale results.
    if (cached.historyDays !== historyDays) {
      return null;
    }
```

**Step 2: Commit**

```bash
git add src/server/core/history.ts
git commit -m "chore(history): document cache day-range invariant"
```

---

## Fix 3 — Negation/Exception Support (`~` operator)

AutoMod supports negating text conditions with `~`. For example:

```yaml
title:
  includes-word: [crypto, nft]
  ~includes-word: [news, discussion]
action: remove
```

This matches posts whose title includes "crypto" or "nft" **but NOT** "news" or "discussion". This is the `~` prefix on a modifier key.

Real mods use this constantly to build allowlists alongside removal rules. Without it, the sandbox warns about the missing modifier but can't evaluate it.

### Implementation plan

**Data model change:** `TextCondition` gains an optional `excludes` array of sub-conditions that must ALL be false for the overall condition to match.

```ts
export interface TextCondition {
  modifier: TextModifier;
  values: string[];
  caseSensitive: boolean;
  excludes?: TextCondition[];   // ← new: each must NOT match
}
```

**Parser change:** In `parseTextConditionValue`, after collecting `modifierKeys`, also collect `~`-prefixed modifier keys and parse them as exclusion conditions.

**Evaluator change:** In `matchText` / `findTextMatch`, after a positive match, check that none of the `excludes` conditions match the target. If any exclusion matches, the overall match fails.

---

### Task 3a: Update types

**Files:**
- Modify: `src/engine/types.ts`

**Step 1: Write failing tests first**

Add to `src/engine/__tests__/engine.test.ts` (inside `describe('parseRules', ...)`):

```ts
it('parses ~ negation modifier on title', () => {
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
```

Add to `describe('evaluate: title conditions', ...)`:

```ts
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

it('negation: does not match when positive does not hit', () => {
  const [rule] = parseOnly(`
title:
  includes-word: [crypto]
  ~includes-word: [news]
action: remove
`);
  expect(evaluate(rule!, makePost({ title: 'Hello world' }), 0).matched).toBe(false);
});
```

**Step 2: Run to confirm failures**

```bash
npm test
```
Expected: multiple FAILs — `excludes` is undefined.

**Step 3: Add `excludes` to `TextCondition`**

In `src/engine/types.ts`, update the `TextCondition` interface:

```ts
export interface TextCondition {
  modifier: TextModifier;
  values: string[];
  caseSensitive: boolean;
  excludes?: TextCondition[];
}
```

---

### Task 3b: Update the parser to extract `~` modifier keys

**Files:**
- Modify: `src/engine/parser.ts`

**Step 1: Extend `findModifierKeys` to also find negated keys**

We need a parallel function that finds `~`-prefixed modifier keys. Add a new function after `findModifierKeys`:

```ts
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
```

**Step 2: Update `parseTextConditionValue` to collect excludes**

In `parseTextConditionValue`, before checking for unknown keys in `block`, add the negated key scan. Then parse each negated modifier as a sub-condition and attach it to the returned `TextCondition`.

Find the section where `unsupportedKeys` are detected (the loop over `Object.keys(block)` that checks `!TEXT_METADATA_KEYS.has(key) && !SUPPORTED_TEXT_MODIFIERS.includes(...) && !(key in TEXT_MODIFIER_ALIASES)`). Update this check to also allow `~`-prefixed known modifiers:

```ts
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
      !isNegatedModifier(key)              // ← new guard
    ) {
      // ... existing unsupported key warning code
    }
  }
```

Then, after building the main `condition`, collect all negated keys and build the `excludes` array:

```ts
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
```

**Step 3: Run tests — parser tests should pass, evaluator tests still fail**

```bash
npm test
```
Expected: parser negation tests pass; evaluate negation tests fail because `matchText` ignores `excludes`.

---

### Task 3c: Update the text evaluator to honour exclusions

**Files:**
- Modify: `src/engine/conditions/text.ts`

**Step 1: Update `matchText` and `findTextMatch` to check exclusions**

In `src/engine/conditions/text.ts`, update `findTextMatch`:

```ts
export function findTextMatch(condition: TextCondition, target: string): string | undefined {
  const { modifier, values, caseSensitive, excludes } = condition;

  for (const rawValue of values) {
    const matched = applyModifier(modifier, target, rawValue, caseSensitive);
    if (matched !== undefined) {
      // Check exclusions — if ANY exclusion matches, the overall match fails
      if (excludes && excludes.some((excl) => findTextMatch(excl, target) !== undefined)) {
        return undefined;
      }
      return matched;
    }
  }

  return undefined;
}
```

`matchText` calls `findTextMatch`, so no change needed there.

**Step 2: Run all tests**

```bash
npm test
```
Expected: All tests pass including all negation tests.

**Step 3: Commit**

```bash
git add src/engine/types.ts src/engine/parser.ts src/engine/conditions/text.ts src/engine/__tests__/engine.test.ts
git commit -m "feat(engine): support ~ negation/exception operator for text conditions"
```

---

## Final Verification

```bash
npm test
```

Expected output: all tests pass (39 original + ~7 new = ~46 total).

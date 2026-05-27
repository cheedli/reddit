import { describe, expect, it } from 'vitest';
import type { Comment, Item } from '../../engine/types.js';
import type { ModRemovalRecord } from '../../shared/api.js';
import { generateRuleSuggestions } from '../core/suggestions.js';

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    kind: 'comment',
    id: 't1_default',
    body: 'discount code now',
    author: 'user',
    authorId: 't2_user',
    authorCommentKarma: 2,
    authorPostKarma: 0,
    authorAccountAge: 2,
    authorIsMod: false,
    authorIsGold: false,
    authorFlairText: '',
    authorFlairCssClass: '',
    createdAt: Date.now(),
    edited: false,
    flairText: '',
    flairCssClass: '',
    reports: 0,
    permalink: '/r/test/comments/x',
    postTitle: 'discount code',
    postId: 't3_parent',
    ...overrides,
  };
}

function makeRemoval(id: string, body: string, authorAccountAge: number): ModRemovalRecord {
  return {
    id,
    kind: 'comment',
    body,
    author: `user_${id}`,
    authorId: `t2_${id}`,
    authorCommentKarma: 1,
    authorPostKarma: 0,
    authorAccountAge,
    authorIsMod: false,
    authorIsGold: false,
    moderator: 'mod_user',
    removedAt: Date.now(),
    signalSource: 'resolved',
  };
}

describe('suggestion scoring', () => {
  it('returns history-scored suggestions without an OpenAI key', async () => {
    const removals = [
      makeRemoval('t1_r1', 'discount code now', 1),
      makeRemoval('t1_r2', 'discount code inside', 2),
      makeRemoval('t1_r3', 'discount code tonight', 1),
      makeRemoval('t1_r4', 'discount code offer', 3),
      makeRemoval('t1_r5', 'discount code available', 2),
    ];

    const historyItems: Item[] = [
      ...removals.map((record) =>
        makeComment({
          id: record.id,
          body: record.body,
          author: record.author,
          authorId: record.authorId ?? '',
          authorCommentKarma: record.authorCommentKarma,
          authorPostKarma: record.authorPostKarma,
          authorAccountAge: record.authorAccountAge,
        })
      ),
      makeComment({
        id: 't1_fp1',
        body: 'discount code for the moderation handbook',
        author: 'trusted_user',
        authorId: 't2_fp',
        authorCommentKarma: 200,
        authorAccountAge: 400,
      }),
      makeComment({
        id: 't1_safe1',
        body: 'normal discussion thread',
        author: 'safe_user',
        authorId: 't2_safe',
        authorCommentKarma: 120,
        authorAccountAge: 900,
      }),
    ];

    const suggestions = await generateRuleSuggestions({
      historyItems,
      removals,
      falsePositiveIds: ['t1_fp1'],
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.estimatedPrecision).toBeGreaterThan(0.5);
    expect(suggestions[0]?.historyMatchCount).toBeGreaterThanOrEqual(suggestions[0]?.matchCount ?? 0);
    expect(suggestions[0]?.confidence).not.toBe('low');
  });

  it('does not suggest stale removal-only rules with no current history matches', async () => {
    const removals = [
      makeRemoval('t1_r1', '[AutoMod Studio seed] telegram discount followers promo guaranteed offer', 1),
      makeRemoval('t1_r2', '[AutoMod Studio seed] telegram discount followers promo guaranteed offer', 2),
      makeRemoval('t1_r3', '[AutoMod Studio seed] telegram discount followers promo guaranteed offer', 1),
      makeRemoval('t1_r4', '[AutoMod Studio seed] telegram discount followers promo guaranteed offer', 3),
      makeRemoval('t1_r5', '[AutoMod Studio seed] telegram discount followers promo guaranteed offer', 2),
    ].map((record) => ({
      ...record,
      author: 'automod-studio-seed',
      removalReason: 'AutoMod Studio generated training data',
      synthetic: true,
    }));

    const suggestions = await generateRuleSuggestions({
      historyItems: [
        makeComment({
          id: 't1_live1',
          body: 'normal discussion thread',
          authorCommentKarma: 200,
          authorAccountAge: 800,
        }),
      ],
      removals,
      falsePositiveIds: [],
    });

    expect(suggestions).toEqual([]);
  });
});

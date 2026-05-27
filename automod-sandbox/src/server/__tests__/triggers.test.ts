import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisState, mockContext, mockRedis, mockReddit } = vi.hoisted(
  () => {
    const redisState = new Map<string, string>();
    const mockContext = {
      subredditName: 'TestSub',
      username: 'mod_user',
    };

    const mockAuthor = {
      id: 't2_author',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      linkKarma: 42,
      commentKarma: 7,
      isModerator: false,
      hasRedditPremium: true,
      getModPermissionsForSubreddit: vi.fn(async () => []),
    };

    const mockComment = {
      id: 't1_comment',
      authorId: 't2_author',
      authorName: 'troublemaker',
      body: 'buy discount code now',
      getAuthor: vi.fn(async () => mockAuthor),
    };

    const mockRedis = {
      get: vi.fn(async (key: string) => redisState.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        redisState.set(key, value);
      }),
    };

    const mockReddit = {
      getCommentById: vi.fn(async () => mockComment),
    };

    return { redisState, mockContext, mockRedis, mockReddit };
  }
);

vi.mock('@devvit/web/server', () => ({
  context: mockContext,
  reddit: mockReddit,
  redis: mockRedis,
}));

import { getModRemovalRecords } from '../core/moderationMemory.js';
import { triggers } from '../routes/triggers.js';

describe('moderation learning trigger integration', () => {
  beforeEach(() => {
    redisState.clear();
    vi.clearAllMocks();
  });

  it('records resolved author signals from a moderator removal action', async () => {
    const response = await triggers.request('http://localhost/on-mod-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'removecomment',
        moderator: { name: 'mod_user' },
        targetComment: {
          id: 't1_comment',
          author: 'troublemaker',
          body: 'buy discount code now',
        },
        targetUser: {
          id: 't2_author',
          name: 'troublemaker',
          karma: 99,
        },
      }),
    });

    expect(response.status).toBe(200);
    const records = await getModRemovalRecords('TestSub');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 't1_comment',
      author: 'troublemaker',
      authorCommentKarma: 7,
      authorPostKarma: 42,
      authorIsGold: true,
      signalSource: 'resolved',
    });
    expect(records[0]?.authorAccountAge).toBeGreaterThan(0);
  });
});

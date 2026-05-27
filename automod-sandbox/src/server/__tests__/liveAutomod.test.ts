import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisState, wikiState, mockRedis, mockReddit } = vi.hoisted(() => {
  const redisState = new Map<string, string>();
  const wikiState: {
    exists: boolean;
    content: string;
    revisionId: string;
    revisionDate: Date;
    revisionReason: string | null;
  } = {
    exists: true,
    content: 'type: submission\naction: remove\n',
    revisionId: 'rev-old',
    revisionDate: new Date('2026-05-01T00:00:00Z'),
    revisionReason: 'Initial config',
  };

  const mockRedis = {
    get: vi.fn(async (key: string) => redisState.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisState.set(key, value);
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) redisState.delete(key);
    }),
  };

  const mockReddit = {
    getWikiPages: vi.fn(async () => (wikiState.exists ? ['config/automoderator'] : [])),
    getWikiPage: vi.fn(async () => ({
      content: wikiState.content,
      revisionId: wikiState.revisionId,
      revisionDate: wikiState.revisionDate,
      revisionReason: wikiState.revisionReason,
    })),
    updateWikiPage: vi.fn(async ({ content, reason }: { content: string; reason?: string }) => {
      wikiState.exists = true;
      wikiState.content = content;
      wikiState.revisionId = 'rev-new';
      wikiState.revisionDate = new Date('2026-05-02T00:00:00Z');
      wikiState.revisionReason = reason ?? null;
    }),
    createWikiPage: vi.fn(async ({ content, reason }: { content: string; reason?: string }) => {
      wikiState.exists = true;
      wikiState.content = content;
      wikiState.revisionId = 'rev-created';
      wikiState.revisionDate = new Date('2026-05-02T00:00:00Z');
      wikiState.revisionReason = reason ?? null;
    }),
    revertWikiPage: vi.fn(async (_subredditName: string, _page: string, revisionId: string) => {
      wikiState.exists = true;
      wikiState.content = 'type: submission\naction: remove\n';
      wikiState.revisionId = revisionId;
      wikiState.revisionDate = new Date('2026-05-03T00:00:00Z');
      wikiState.revisionReason = 'Rollback';
    }),
  };

  return { redisState, wikiState, mockRedis, mockReddit };
});

vi.mock('@devvit/web/server', () => ({
  reddit: mockReddit,
  redis: mockRedis,
}));

import { applyLiveRules, rollbackLiveRules, saveLiveDraft } from '../core/liveAutomod.js';

describe('live AutoMod integration', () => {
  beforeEach(() => {
    redisState.clear();
    wikiState.exists = true;
    wikiState.content = 'type: submission\naction: remove\n';
    wikiState.revisionId = 'rev-old';
    wikiState.revisionDate = new Date('2026-05-01T00:00:00Z');
    wikiState.revisionReason = 'Initial config';
    vi.clearAllMocks();
  });

  it('saves a rollback snapshot before apply and reverts to the previous revision', async () => {
    const applied = await applyLiveRules(
      'TestSub',
      'type: any\naction: filter\naction_reason: "new config"\n',
      'Apply test'
    );

    expect(applied.applied).toBe(true);
    expect(mockReddit.updateWikiPage).toHaveBeenCalledTimes(1);
    expect(redisState.get('automod-sandbox:automod-rollback:testsub')).toContain('"revisionId":"rev-old"');

    const rolledBack = await rollbackLiveRules('TestSub', 'Rollback test');

    expect(rolledBack.rolledBack).toBe(true);
    expect(mockReddit.revertWikiPage).toHaveBeenCalledWith(
      'TestSub',
      'config/automoderator',
      'rev-old'
    );
    expect(wikiState.content).toBe('type: submission\naction: remove\n');
  });

  it('appends draft rules without creating empty yaml documents', async () => {
    wikiState.content = '---\ntype: submission\naction: remove\n...\n';

    const applied = await applyLiveRules(
      'TestSub',
      '---\ntype: comment\naction: filter\n',
      'Apply draft',
      'append'
    );

    expect(applied.applied).toBe(true);
    expect(wikiState.content).toBe(
      'type: submission\naction: remove\n\n---\ntype: comment\naction: filter\n'
    );
  });

  it('does not duplicate an already-live rule when appending', async () => {
    wikiState.content = 'type: comment\naction: filter\n';

    const applied = await applyLiveRules(
      'TestSub',
      'type: comment\naction: filter\n',
      'Apply draft',
      'append'
    );

    expect(applied.applied).toBe(false);
    expect(wikiState.content).toBe('type: comment\naction: filter\n');
  });

  it('preserves existing draft rules when saving another draft rule', async () => {
    redisState.set(
      'automod-sandbox:automod-draft:testsub',
      JSON.stringify({
        yaml: 'type: submission\naction: remove\n',
        updatedAt: Date.now(),
      })
    );

    await saveLiveDraft('TestSub', 'type: comment\naction: filter\n');

    expect(wikiState.content).toBe(
      'type: submission\naction: remove\n\n---\ntype: comment\naction: filter\n'
    );
  });

  it('normalizes AutoModerator aliases before writing live yaml', async () => {
    const applied = await applyLiveRules(
      'TestSub',
      'type: submission\nauthor:\n  post_karma: "< 10"\n  is_mod: false\naction: filter\n',
      'Apply normalized config'
    );

    expect(applied.applied).toBe(true);
    expect(wikiState.content).toContain('  link_karma: "< 10"');
    expect(wikiState.content).toContain('  is_moderator: false');
    expect(wikiState.content).not.toContain('post_karma');
    expect(wikiState.content).not.toMatch(/^\s*is_mod\s*:/m);
  });
});

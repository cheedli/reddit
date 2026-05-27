import { reddit } from '@devvit/web/server';
import type { OnModActionRequest } from '@devvit/web/shared';
import type { ModRemovalRecord } from '../../shared/api.js';
import {
  getAuthorSignalSnapshot,
  upsertAuthorSignalSnapshot,
  type SnapshotAuthorSignals,
} from './authorSignalSnapshots.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type CommentId = `t1_${string}`;
type UserId = `t2_${string}`;
type PostId = `t3_${string}`;

type AuthorSignals = {
  authorId?: string;
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number;
  authorIsMod?: boolean;
  authorIsGold?: boolean;
  signalSource: 'resolved' | 'snapshot' | 'fallback';
  authorCreatedAtMs?: number;
};

function isCommentId(id: string): id is CommentId {
  return id.startsWith('t1_');
}

function isUserId(id: string): id is UserId {
  return id.startsWith('t2_');
}

function isPostId(id: string): id is PostId {
  return id.startsWith('t3_');
}

async function resolveIsModerator(
  user: {
    isModerator: boolean;
    getModPermissionsForSubreddit(subredditName: string): Promise<unknown[]>;
  },
  subredditName: string
): Promise<boolean> {
  if (!user.isModerator) return false;

  try {
    return (await user.getModPermissionsForSubreddit(subredditName)).length > 0;
  } catch {
    return false;
  }
}

async function buildAuthorSignalsFromUser(
  subredditName: string,
  user: {
    id: string;
    createdAt: Date;
    linkKarma: number;
    commentKarma: number;
    isModerator: boolean;
    hasRedditPremium: boolean;
    getModPermissionsForSubreddit(subredditName: string): Promise<unknown[]>;
  }
): Promise<AuthorSignals> {
  return {
    authorId: user.id,
    authorCommentKarma: user.commentKarma,
    authorPostKarma: user.linkKarma,
    authorAccountAge: Math.max(0, Math.floor((Date.now() - user.createdAt.getTime()) / DAY_MS)),
    authorIsMod: await resolveIsModerator(user, subredditName),
    authorIsGold: user.hasRedditPremium,
    signalSource: 'resolved',
    authorCreatedAtMs: user.createdAt.getTime(),
  };
}

function fallbackSignals(
  fallbackKarma = 0,
  authorId?: string
): AuthorSignals {
  const signals: AuthorSignals = {
    authorCommentKarma: fallbackKarma,
    authorPostKarma: fallbackKarma,
    authorAccountAge: 0,
    signalSource: 'fallback',
  };
  if (authorId) {
    signals.authorId = authorId;
  }
  return signals;
}

async function resolveAuthorSignals(
  subredditName: string,
  options: {
    itemId?: string;
    authorId?: string;
    authorName?: string;
    fallbackKarma?: number;
    user?: {
      id: string;
      createdAt: Date;
      linkKarma: number;
      commentKarma: number;
      isModerator: boolean;
      hasRedditPremium: boolean;
      getModPermissionsForSubreddit(subredditName: string): Promise<unknown[]>;
    };
  }
): Promise<AuthorSignals> {
  if (options.user) {
    return buildAuthorSignalsFromUser(subredditName, options.user);
  }

  if (options.authorId && isUserId(options.authorId)) {
    try {
      const user = await reddit.getUserById(options.authorId);
      if (user) {
        return buildAuthorSignalsFromUser(subredditName, user);
      }
    } catch {
      // fall through to username/fallback
    }
  }

  if (options.authorName && options.authorName !== '[deleted]' && options.authorName !== 'unknown') {
    try {
      const user = await reddit.getUserByUsername(options.authorName);
      if (user) {
        return buildAuthorSignalsFromUser(subredditName, user);
      }
    } catch {
      // fall through to fallback
    }
  }

  const snapshot = await getAuthorSignalSnapshot(subredditName, {
    itemId: options.itemId,
    authorId: options.authorId,
    authorName: options.authorName,
  });
  if (snapshot) {
    return snapshot satisfies SnapshotAuthorSignals;
  }

  return fallbackSignals(options.fallbackKarma ?? 0, options.authorId);
}

function withSignals(record: Omit<ModRemovalRecord, 'authorCommentKarma' | 'authorPostKarma' | 'authorAccountAge'>, signals: AuthorSignals): ModRemovalRecord {
  const next: ModRemovalRecord = {
    ...record,
    authorCommentKarma: signals.authorCommentKarma,
    authorPostKarma: signals.authorPostKarma,
    authorAccountAge: signals.authorAccountAge,
    signalSource: signals.signalSource,
  };

  if (signals.authorId !== undefined) {
    next.authorId = signals.authorId;
  }
  if (signals.authorIsMod !== undefined) {
    next.authorIsMod = signals.authorIsMod;
  }
  if (signals.authorIsGold !== undefined) {
    next.authorIsGold = signals.authorIsGold;
  }

  return next;
}

async function persistReusableSignals(
  subredditName: string,
  record: ModRemovalRecord,
  signals: AuthorSignals
): Promise<void> {
  if (signals.signalSource !== 'resolved') return;

  await upsertAuthorSignalSnapshot(subredditName, {
    itemId: record.id,
    authorId: signals.authorId ?? record.authorId,
    authorName: record.author,
    authorCommentKarma: signals.authorCommentKarma,
    authorPostKarma: signals.authorPostKarma,
    authorAccountAge: signals.authorAccountAge,
    authorCreatedAtMs: signals.authorCreatedAtMs,
    authorIsMod: signals.authorIsMod,
    authorIsGold: signals.authorIsGold,
    observedAt: record.removedAt,
  });
}

export async function buildRemovalRecord(
  subredditName: string,
  input: OnModActionRequest
): Promise<ModRemovalRecord | null> {
  const targetPost = input.targetPost;
  const targetComment = input.targetComment;
  const targetId = targetComment?.id ?? targetPost?.id;
  if (!targetId) return null;

  const moderatorName = input.moderator?.name ?? 'unknown';
  const authorName = targetComment?.author ?? input.targetUser?.name ?? 'unknown';
  const baseRecord = {
    id: targetId,
    kind:
      input.action === 'removecomment' || input.action === 'spamcomment' ? 'comment' : 'post',
    title: targetPost?.title || undefined,
    body: targetComment?.body ?? targetPost?.selftext ?? '',
    author: authorName,
    moderator: moderatorName,
    removedAt: Date.now(),
  } satisfies Omit<
    ModRemovalRecord,
    'authorCommentKarma' | 'authorPostKarma' | 'authorAccountAge'
  >;

  if (isCommentId(targetId)) {
    try {
      const comment = await reddit.getCommentById(targetId);
      const user = await comment.getAuthor().catch(() => undefined);
      const signals = await resolveAuthorSignals(subredditName, {
        itemId: comment.id,
        authorId: comment.authorId,
        authorName: comment.authorName,
        fallbackKarma: input.targetUser?.karma ?? 0,
        user,
      });
      const record = withSignals(
        {
          ...baseRecord,
          id: comment.id,
          kind: 'comment',
          body: comment.body,
          author: comment.authorName,
        },
        signals
      );
      await persistReusableSignals(subredditName, record, signals);
      return record;
    } catch {
      // fall through to fallback
    }
  }

  if (isPostId(targetId)) {
    try {
      const post = await reddit.getPostById(targetId);
      const user = await post.getAuthor().catch(() => undefined);
      const signals = await resolveAuthorSignals(subredditName, {
        itemId: post.id,
        authorId: post.authorId,
        authorName: post.authorName,
        fallbackKarma: input.targetUser?.karma ?? 0,
        user,
      });
      const record = withSignals(
        {
          ...baseRecord,
          id: post.id,
          kind: 'post',
          title: post.title,
          body: post.body ?? '',
          author: post.authorName,
        },
        signals
      );
      await persistReusableSignals(subredditName, record, signals);
      return record;
    } catch {
      // fall through to fallback
    }
  }

  const signals = await resolveAuthorSignals(subredditName, {
    itemId: targetId,
    authorId: input.targetUser?.id,
    authorName,
    fallbackKarma: input.targetUser?.karma ?? 0,
  });
  const record = withSignals(baseRecord, signals);
  await persistReusableSignals(subredditName, record, signals);
  return record;
}

export async function hydrateRemovalRecord(
  subredditName: string,
  record: ModRemovalRecord
): Promise<ModRemovalRecord> {
  if (record.signalSource === 'resolved') {
    return record;
  }

  const signals = await resolveAuthorSignals(subredditName, {
    itemId: record.id,
    authorId: record.authorId,
    authorName: record.author,
    fallbackKarma: Math.max(record.authorCommentKarma, record.authorPostKarma),
  });

  if (
    signals.signalSource === record.signalSource &&
    signals.authorCommentKarma === record.authorCommentKarma &&
    signals.authorPostKarma === record.authorPostKarma &&
    signals.authorAccountAge === record.authorAccountAge &&
    signals.authorId === record.authorId &&
    signals.authorIsMod === record.authorIsMod &&
    signals.authorIsGold === record.authorIsGold
  ) {
    return record;
  }

  return withSignals(
    {
      id: record.id,
      kind: record.kind,
      title: record.title,
      body: record.body,
      author: record.author,
      moderator: record.moderator,
      removedAt: record.removedAt,
      removalReason: record.removalReason,
      synthetic: record.synthetic,
    },
    signals
  );
}

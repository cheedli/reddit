import { reddit, redis, settings } from '@devvit/web/server';
import type { Item } from '../../engine/types.js';
import { store } from '../store.js';
import { upsertAuthorSignalSnapshotsFromItems } from './authorSignalSnapshots.js';

const DEFAULT_HISTORY_DAYS = 30;
const MAX_HISTORY_DAYS = 90;
const MAX_POSTS = 500;
const MAX_COMMENT_SOURCE_POSTS = 150;
const MAX_COMMENTS_PER_POST = 12;
const MAX_COMMENTS = 1000;
const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_CACHE_VERSION = 3;
const HISTORY_KEY_PREFIX = 'automod-sandbox:history:';
const MIN_SANDBOX_ITEMS = 0;
const AUTOMOD_STUDIO_SEED_PREFIX = '[AutoMod Studio seed]';

type HistoryCacheRecord = {
  version: number;
  historyDays: number;
  fetchedAt: number;
  items: Item[];
};

type HistorySnapshot = {
  items: Item[];
  fetchedAt: number;
  historyDays: number;
};

type AuthorSignals = {
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number;
  authorIsMod: boolean;
  authorIsGold: boolean;
};

type RedditUser = {
  createdAt: Date;
  linkKarma: number;
  commentKarma: number;
  isModerator: boolean;
  hasRedditPremium: boolean;
  getModPermissionsForSubreddit(subredditName: string): Promise<unknown[]>;
};

type FlairShape = {
  text?: string;
  cssClass?: string;
};

type RedditComment = {
  id: string;
  authorId?: string;
  authorName: string;
  body: string;
  createdAt: Date;
  postId: string;
  edited: boolean;
  numReports: number;
  permalink: string;
  authorFlair?: FlairShape;
  getAuthor(): Promise<RedditUser | undefined>;
};

type RedditPost = {
  id: string;
  title: string;
  body?: string;
  url: string;
  authorId?: string;
  authorName: string;
  createdAt: Date;
  edited: boolean | Date;
  numberOfReports: number;
  permalink: string;
  thumbnail?: { url: string };
  flair?: FlairShape;
  authorFlair?: FlairShape;
  comments: {
    get(count: number): Promise<RedditComment[]>;
  };
  getAuthor(): Promise<RedditUser | undefined>;
};

function clampHistoryDays(value: unknown): number {
  const days = Number(value);
  if (!Number.isFinite(days)) return DEFAULT_HISTORY_DAYS;
  return Math.min(MAX_HISTORY_DAYS, Math.max(1, Math.floor(days)));
}

export async function getHistoryDaysSetting(): Promise<number> {
  const value = await settings.get('historyDays').catch(() => DEFAULT_HISTORY_DAYS);
  return clampHistoryDays(value);
}

function historyKey(subredditName: string): string {
  return `${HISTORY_KEY_PREFIX}${subredditName.toLowerCase()}`;
}

function setInMemoryHistory(
  subredditName: string,
  historyDays: number,
  items: Item[],
  fetchedAt: number
): HistorySnapshot {
  store.items = items;
  store.fetchedAt = fetchedAt;
  store.historySubreddit = subredditName;
  store.historyDays = historyDays;
  return { items, fetchedAt, historyDays };
}

function isAutomodStudioSeedItem(item: Item): boolean {
  if (item.kind === 'post') {
    return (
      item.title.startsWith(AUTOMOD_STUDIO_SEED_PREFIX) ||
      item.body.includes('AutoMod testing only') ||
      item.body.includes('Seed content for suggestion training only') ||
      item.body.includes('suggestion training only') ||
      item.url.includes('seed=')
    );
  }

  return (
    item.body.startsWith(AUTOMOD_STUDIO_SEED_PREFIX) ||
    item.postTitle.startsWith(AUTOMOD_STUDIO_SEED_PREFIX)
  );
}

function filterAutomodStudioSeedItems(items: Item[]): Item[] {
  return items.filter((item) => !isAutomodStudioSeedItem(item));
}

function hasMatchingInMemoryHistory(subredditName: string, historyDays: number): boolean {
  return (
    store.fetchedAt !== null &&
    store.historySubreddit === subredditName &&
    store.historyDays === historyDays
  );
}

function parseHistoryCacheRecord(raw: string): HistoryCacheRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<HistoryCacheRecord>;
    if (
      parsed.version !== HISTORY_CACHE_VERSION ||
      !Array.isArray(parsed.items) ||
      typeof parsed.fetchedAt !== 'number' ||
      typeof parsed.historyDays !== 'number'
    ) {
      return null;
    }

    return {
      version: parsed.version,
      historyDays: parsed.historyDays,
      fetchedAt: parsed.fetchedAt,
      items: parsed.items as Item[],
    };
  } catch {
    return null;
  }
}

async function writeHistoryCache(
  subredditName: string,
  historyDays: number,
  items: Item[],
  fetchedAt: number
): Promise<void> {
  const payload: HistoryCacheRecord = {
    version: HISTORY_CACHE_VERSION,
    historyDays,
    fetchedAt,
    items,
  };

  try {
    await redis.set(historyKey(subredditName), JSON.stringify(payload));
  } catch (error) {
    console.error('[history-cache] write error:', error);
  }
}

export async function getCachedHistory(
  subredditName: string,
  historyDays: number
): Promise<HistorySnapshot | null> {
  if (!subredditName) return null;

  if (hasMatchingInMemoryHistory(subredditName, historyDays)) {
    return {
      items: store.items,
      fetchedAt: store.fetchedAt!,
      historyDays,
    };
  }

  try {
    const raw = await redis.get(historyKey(subredditName));
    if (!raw) return null;

    const cached = parseHistoryCacheRecord(raw);
    if (!cached) {
      console.warn(`[history-cache] invalid cache payload for r/${subredditName}`);
      return null;
    }
    // Reject cache hits from a different day-range setting to avoid stale results.
    if (cached.historyDays !== historyDays) {
      return null;
    }

    const items = filterAutomodStudioSeedItems(cached.items);
    const snapshot = setInMemoryHistory(subredditName, historyDays, items, cached.fetchedAt);
    await upsertAuthorSignalSnapshotsFromItems(subredditName, items, cached.fetchedAt);
    return snapshot;
  } catch (error) {
    console.error('[history-cache] read error:', error);
    return null;
  }
}

async function getAuthorSignals(
  userPromise: Promise<RedditUser | undefined>,
  subredditName: string
): Promise<AuthorSignals> {
  try {
    const user = await userPromise;
    if (!user) {
      return {
        authorCommentKarma: 0,
        authorPostKarma: 0,
        authorAccountAge: 0,
        authorIsMod: false,
        authorIsGold: false,
      };
    }

    let isMod = false;
    if (user.isModerator) {
      try {
        isMod = (await user.getModPermissionsForSubreddit(subredditName)).length > 0;
      } catch {
        isMod = false;
      }
    }

    return {
      authorCommentKarma: user.commentKarma,
      authorPostKarma: user.linkKarma,
      authorAccountAge: Math.max(0, Math.floor((Date.now() - user.createdAt.getTime()) / DAY_MS)),
      authorIsMod: isMod,
      authorIsGold: user.hasRedditPremium,
    };
  } catch {
    return {
      authorCommentKarma: 0,
      authorPostKarma: 0,
      authorAccountAge: 0,
      authorIsMod: false,
      authorIsGold: false,
    };
  }
}

async function resolveAuthorSignals(
  key: string,
  subredditName: string,
  cache: Map<string, Promise<AuthorSignals>>,
  loadUser: () => Promise<RedditUser | undefined>
): Promise<AuthorSignals> {
  const cacheKey = key.toLowerCase();

  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, getAuthorSignals(loadUser(), subredditName));
  }

  const signals = cache.get(cacheKey);
  if (!signals) {
    return {
      authorCommentKarma: 0,
      authorPostKarma: 0,
      authorAccountAge: 0,
      authorIsMod: false,
      authorIsGold: false,
    };
  }

  return signals;
}

function toDomain(post: RedditPost, subredditName: string): string {
  if (post.body && post.url.includes('/comments/')) {
    return `self.${subredditName.toLowerCase()}`;
  }

  try {
    return new URL(post.url).hostname.replace(/^www\./, '');
  } catch {
    return post.body ? `self.${subredditName.toLowerCase()}` : '';
  }
}

async function toPostItem(
  post: RedditPost,
  subredditName: string,
  authorCache: Map<string, Promise<AuthorSignals>>
): Promise<Item> {
  const authorKey = post.authorId ?? post.authorName;
  const authorSignals = await resolveAuthorSignals(
    authorKey,
    subredditName,
    authorCache,
    () => post.getAuthor()
  );

  return {
    kind: 'post',
    id: post.id,
    title: post.title,
    body: post.body ?? '',
    url: post.url,
    domain: toDomain(post, subredditName),
    author: post.authorName,
    authorId: post.authorId ?? '',
    authorCommentKarma: authorSignals.authorCommentKarma,
    authorPostKarma: authorSignals.authorPostKarma,
    authorAccountAge: authorSignals.authorAccountAge,
    authorIsMod: authorSignals.authorIsMod,
    authorIsGold: authorSignals.authorIsGold,
    authorFlairText: post.authorFlair?.text ?? '',
    authorFlairCssClass: post.authorFlair?.cssClass ?? '',
    createdAt: post.createdAt.getTime(),
    edited: Boolean(post.edited),
    flairText: post.flair?.text ?? '',
    flairCssClass: post.flair?.cssClass ?? '',
    reports: post.numberOfReports,
    permalink: post.permalink,
    thumbnail: post.thumbnail?.url,
  };
}

async function toCommentItem(
  comment: RedditComment,
  postTitle: string,
  subredditName: string,
  authorCache: Map<string, Promise<AuthorSignals>>
): Promise<Item> {
  const authorKey = comment.authorId ?? comment.authorName;
  const authorSignals = await resolveAuthorSignals(
    authorKey,
    subredditName,
    authorCache,
    () => comment.getAuthor()
  );

  return {
    kind: 'comment',
    id: comment.id,
    body: comment.body,
    author: comment.authorName,
    authorId: comment.authorId ?? '',
    authorCommentKarma: authorSignals.authorCommentKarma,
    authorPostKarma: authorSignals.authorPostKarma,
    authorAccountAge: authorSignals.authorAccountAge,
    authorIsMod: authorSignals.authorIsMod,
    authorIsGold: authorSignals.authorIsGold,
    authorFlairText: comment.authorFlair?.text ?? '',
    authorFlairCssClass: comment.authorFlair?.cssClass ?? '',
    createdAt: comment.createdAt.getTime(),
    edited: comment.edited,
    flairText: '',
    flairCssClass: '',
    reports: comment.numReports,
    permalink: comment.permalink,
    postTitle,
    postId: comment.postId,
  };
}

async function loadRecentCommentSources(posts: RedditPost[], cutoffMs: number): Promise<
  Array<{ comment: RedditComment; postTitle: string }>
> {
  const comments: Array<{ comment: RedditComment; postTitle: string }> = [];

  for (const post of posts.slice(0, MAX_COMMENT_SOURCE_POSTS)) {
    if (comments.length >= MAX_COMMENTS) break;

    try {
      const remaining = MAX_COMMENTS - comments.length;
      const postComments = await post.comments.get(Math.min(MAX_COMMENTS_PER_POST, remaining));

      for (const comment of postComments) {
        if (comment.createdAt.getTime() < cutoffMs) continue;
        comments.push({ comment, postTitle: post.title });
        if (comments.length >= MAX_COMMENTS) break;
      }
    } catch (error) {
      console.error(`[history] failed to load comments for ${post.id}:`, error);
    }
  }

  return comments;
}

export async function loadRecentPosts(subredditName: string, historyDays: number): Promise<Item[]> {
  const cutoffMs = Date.now() - historyDays * DAY_MS;
  const posts = await reddit
    .getNewPosts({
      subredditName,
      limit: MAX_POSTS,
      pageSize: PAGE_SIZE,
    })
    .all();

  const recentPosts = posts
    .filter((post) => post.createdAt.getTime() >= cutoffMs)
    .slice(0, MAX_POSTS);
  const recentComments = await loadRecentCommentSources(recentPosts, cutoffMs);
  const authorCache = new Map<string, Promise<AuthorSignals>>();

  const items = await Promise.all([
    ...recentPosts.map((post) => toPostItem(post, subredditName, authorCache)),
    ...recentComments.map(({ comment, postTitle }) =>
      toCommentItem(comment, postTitle, subredditName, authorCache)
    ),
  ]);

  return filterAutomodStudioSeedItems(items).sort((left, right) => right.createdAt - left.createdAt);
}

export async function fetchFreshHistory(
  subredditName: string,
  historyDays: number
): Promise<HistorySnapshot> {
  const items = await loadRecentPosts(subredditName, historyDays);
  const fetchedAt = Date.now();
  const snapshot = setInMemoryHistory(subredditName, historyDays, items, fetchedAt);
  await writeHistoryCache(subredditName, historyDays, items, fetchedAt);
  await upsertAuthorSignalSnapshotsFromItems(subredditName, items, fetchedAt);
  return snapshot;
}

export async function ensureHistoryLoaded(
  subredditName: string,
  historyDays: number,
  force = false
): Promise<HistorySnapshot> {
  if (!force) {
    const cached = await getCachedHistory(subredditName, historyDays);
    if (cached) return cached;
  }
  return fetchFreshHistory(subredditName, historyDays);
}

export async function loadSandboxHistory(
  subredditName: string,
  historyDays: number,
  options?: { force?: boolean; minItems?: number }
): Promise<HistorySnapshot> {
  const force = options?.force ?? false;
  const minItems = options?.minItems ?? MIN_SANDBOX_ITEMS;

  if (!force) {
    const cached = await getCachedHistory(subredditName, historyDays);
    if (cached && cached.items.length >= minItems) {
      return cached;
    }
    if (cached) {
      console.log(
        `[sandbox-history] cache sparse for r/${subredditName}: ${cached.items.length}/${minItems}; refreshing`
      );
    }
  }

  return fetchFreshHistory(subredditName, historyDays);
}

export type { HistorySnapshot };

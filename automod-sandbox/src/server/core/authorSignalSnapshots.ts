import { redis } from '@devvit/web/server';
import type { Item } from '../../engine/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_CACHE_VERSION = 1;
const SNAPSHOT_KEY_PREFIX = 'automod-sandbox:author-snapshots:';
const MAX_AUTHOR_SNAPSHOTS = 4000;
const MAX_ITEM_SNAPSHOTS = 4000;

type StoredAuthorSignalSnapshot = {
  authorId?: string;
  authorName?: string;
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number;
  authorCreatedAtMs?: number;
  authorIsMod?: boolean;
  authorIsGold?: boolean;
  observedAt: number;
};

type SnapshotCacheRecord = {
  version: number;
  authors: Record<string, StoredAuthorSignalSnapshot>;
  items: Record<string, StoredAuthorSignalSnapshot>;
};

export type SnapshotAuthorSignals = {
  authorId?: string;
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number;
  authorIsMod?: boolean;
  authorIsGold?: boolean;
  signalSource: 'snapshot';
};

type SnapshotLookup = {
  itemId?: string;
  authorId?: string;
  authorName?: string;
};

type SnapshotUpsertInput = {
  itemId?: string;
  authorId?: string;
  authorName?: string;
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number;
  authorCreatedAtMs?: number;
  authorIsMod?: boolean;
  authorIsGold?: boolean;
  observedAt?: number;
};

function snapshotsKey(subredditName: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${subredditName.toLowerCase()}`;
}

function normalizeAuthorKey(value: string): string {
  return value.trim().toLowerCase();
}

function canKeyAuthorName(value: string | undefined): value is string {
  return Boolean(value && value !== '[deleted]' && value !== 'unknown');
}

function parseSnapshotCache(raw: string | null | undefined): SnapshotCacheRecord | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<SnapshotCacheRecord>;
    if (
      parsed.version !== SNAPSHOT_CACHE_VERSION ||
      parsed.authors === null ||
      typeof parsed.authors !== 'object' ||
      parsed.items === null ||
      typeof parsed.items !== 'object'
    ) {
      return null;
    }

    return {
      version: SNAPSHOT_CACHE_VERSION,
      authors: parsed.authors as Record<string, StoredAuthorSignalSnapshot>,
      items: parsed.items as Record<string, StoredAuthorSignalSnapshot>,
    };
  } catch {
    return null;
  }
}

async function readSnapshotCache(subredditName: string): Promise<SnapshotCacheRecord> {
  const raw = await redis.get(snapshotsKey(subredditName)).catch(() => null);
  return (
    parseSnapshotCache(raw) ?? {
      version: SNAPSHOT_CACHE_VERSION,
      authors: {},
      items: {},
    }
  );
}

function trimSnapshotMap(
  entries: Record<string, StoredAuthorSignalSnapshot>,
  maxEntries: number
): Record<string, StoredAuthorSignalSnapshot> {
  const trimmed = Object.entries(entries)
    .sort(([, left], [, right]) => right.observedAt - left.observedAt)
    .slice(0, maxEntries);
  return Object.fromEntries(trimmed);
}

async function writeSnapshotCache(
  subredditName: string,
  record: SnapshotCacheRecord
): Promise<void> {
  await redis.set(
    snapshotsKey(subredditName),
    JSON.stringify({
      version: SNAPSHOT_CACHE_VERSION,
      authors: trimSnapshotMap(record.authors, MAX_AUTHOR_SNAPSHOTS),
      items: trimSnapshotMap(record.items, MAX_ITEM_SNAPSHOTS),
    } satisfies SnapshotCacheRecord)
  );
}

function toStoredSnapshot(input: SnapshotUpsertInput): StoredAuthorSignalSnapshot {
  const observedAt = input.observedAt ?? Date.now();
  return {
    authorId: input.authorId,
    authorName: input.authorName,
    authorCommentKarma: input.authorCommentKarma,
    authorPostKarma: input.authorPostKarma,
    authorAccountAge: input.authorAccountAge,
    authorCreatedAtMs:
      input.authorCreatedAtMs ?? Math.max(0, observedAt - input.authorAccountAge * DAY_MS),
    authorIsMod: input.authorIsMod,
    authorIsGold: input.authorIsGold,
    observedAt,
  };
}

function mergeSnapshot(
  current: StoredAuthorSignalSnapshot | undefined,
  incoming: StoredAuthorSignalSnapshot
): StoredAuthorSignalSnapshot {
  if (!current) return incoming;

  if (incoming.observedAt < current.observedAt) {
    return {
      ...current,
      authorId: current.authorId ?? incoming.authorId,
      authorName: current.authorName ?? incoming.authorName,
      authorIsMod: current.authorIsMod ?? incoming.authorIsMod,
      authorIsGold: current.authorIsGold ?? incoming.authorIsGold,
      authorCreatedAtMs: current.authorCreatedAtMs ?? incoming.authorCreatedAtMs,
    };
  }

  return {
    ...current,
    ...incoming,
    authorId: incoming.authorId ?? current.authorId,
    authorName: incoming.authorName ?? current.authorName,
    authorIsMod: incoming.authorIsMod ?? current.authorIsMod,
    authorIsGold: incoming.authorIsGold ?? current.authorIsGold,
    authorCreatedAtMs: incoming.authorCreatedAtMs ?? current.authorCreatedAtMs,
  };
}

export async function upsertAuthorSignalSnapshot(
  subredditName: string,
  input: SnapshotUpsertInput
): Promise<void> {
  const stored = toStoredSnapshot(input);
  const cache = await readSnapshotCache(subredditName);
  let mutated = false;

  if (input.itemId) {
    const next = mergeSnapshot(cache.items[input.itemId], stored);
    if (JSON.stringify(next) !== JSON.stringify(cache.items[input.itemId])) {
      cache.items[input.itemId] = next;
      mutated = true;
    }
  }
  if (input.authorId) {
    const authorIdKey = normalizeAuthorKey(input.authorId);
    const next = mergeSnapshot(cache.authors[authorIdKey], stored);
    if (JSON.stringify(next) !== JSON.stringify(cache.authors[authorIdKey])) {
      cache.authors[authorIdKey] = next;
      mutated = true;
    }
  }
  if (canKeyAuthorName(input.authorName)) {
    const authorNameKey = normalizeAuthorKey(input.authorName);
    const next = mergeSnapshot(cache.authors[authorNameKey], stored);
    if (JSON.stringify(next) !== JSON.stringify(cache.authors[authorNameKey])) {
      cache.authors[authorNameKey] = next;
      mutated = true;
    }
  }

  if (!mutated) return;
  await writeSnapshotCache(subredditName, cache);
}

function hasReusableHistorySignals(item: Item): boolean {
  return (
    item.author !== '[deleted]' &&
    item.author !== 'unknown' &&
    (item.authorCommentKarma > 0 ||
      item.authorPostKarma > 0 ||
      item.authorAccountAge > 0 ||
      item.authorIsMod ||
      item.authorIsGold)
  );
}

export async function upsertAuthorSignalSnapshotsFromItems(
  subredditName: string,
  items: Item[],
  observedAt = Date.now()
): Promise<void> {
  const cache = await readSnapshotCache(subredditName);
  let mutated = false;

  for (const item of items) {
    if (!hasReusableHistorySignals(item)) continue;

    const stored = toStoredSnapshot({
      itemId: item.id,
      authorId: item.authorId || undefined,
      authorName: item.author,
      authorCommentKarma: item.authorCommentKarma,
      authorPostKarma: item.authorPostKarma,
      authorAccountAge: item.authorAccountAge,
      authorIsMod: item.authorIsMod,
      authorIsGold: item.authorIsGold,
      observedAt,
    });

    const nextItem = mergeSnapshot(cache.items[item.id], stored);
    if (JSON.stringify(nextItem) !== JSON.stringify(cache.items[item.id])) {
      cache.items[item.id] = nextItem;
      mutated = true;
    }
    if (item.authorId) {
      const authorIdKey = normalizeAuthorKey(item.authorId);
      const nextAuthorId = mergeSnapshot(cache.authors[authorIdKey], stored);
      if (JSON.stringify(nextAuthorId) !== JSON.stringify(cache.authors[authorIdKey])) {
        cache.authors[authorIdKey] = nextAuthorId;
        mutated = true;
      }
    }
    if (canKeyAuthorName(item.author)) {
      const authorNameKey = normalizeAuthorKey(item.author);
      const nextAuthorName = mergeSnapshot(cache.authors[authorNameKey], stored);
      if (JSON.stringify(nextAuthorName) !== JSON.stringify(cache.authors[authorNameKey])) {
        cache.authors[authorNameKey] = nextAuthorName;
        mutated = true;
      }
    }
  }

  if (!mutated) return;
  await writeSnapshotCache(subredditName, cache);
}

function toSnapshotSignals(snapshot: StoredAuthorSignalSnapshot): SnapshotAuthorSignals {
  const authorAccountAge = snapshot.authorCreatedAtMs
    ? Math.max(0, Math.floor((Date.now() - snapshot.authorCreatedAtMs) / DAY_MS))
    : snapshot.authorAccountAge +
      Math.max(0, Math.floor((Date.now() - snapshot.observedAt) / DAY_MS));

  return {
    authorId: snapshot.authorId,
    authorCommentKarma: snapshot.authorCommentKarma,
    authorPostKarma: snapshot.authorPostKarma,
    authorAccountAge,
    authorIsMod: snapshot.authorIsMod,
    authorIsGold: snapshot.authorIsGold,
    signalSource: 'snapshot',
  };
}

export async function getAuthorSignalSnapshot(
  subredditName: string,
  lookup: SnapshotLookup
): Promise<SnapshotAuthorSignals | null> {
  const cache = await readSnapshotCache(subredditName);

  if (lookup.itemId) {
    const itemSnapshot = cache.items[lookup.itemId];
    if (itemSnapshot) {
      return toSnapshotSignals(itemSnapshot);
    }
  }

  if (lookup.authorId) {
    const authorIdSnapshot = cache.authors[normalizeAuthorKey(lookup.authorId)];
    if (authorIdSnapshot) {
      return toSnapshotSignals(authorIdSnapshot);
    }
  }

  if (canKeyAuthorName(lookup.authorName)) {
    const authorNameSnapshot = cache.authors[normalizeAuthorKey(lookup.authorName)];
    if (authorNameSnapshot) {
      return toSnapshotSignals(authorNameSnapshot);
    }
  }

  return null;
}

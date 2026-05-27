import { redis } from '@devvit/web/server';
import type { ModRemovalRecord } from '../../shared/api.js';

const REMOVALS_KEY_PREFIX = 'automod-sandbox:removals:';
const FALSE_POSITIVES_KEY_PREFIX = 'automod-sandbox:false-positives:';
const MAX_REMOVALS = 1000;

function removalsKey(subredditName: string): string {
  return `${REMOVALS_KEY_PREFIX}${subredditName.toLowerCase()}`;
}

function falsePositivesKey(subredditName: string): string {
  return `${FALSE_POSITIVES_KEY_PREFIX}${subredditName.toLowerCase()}`;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isModRemovalRecord(value: unknown): value is ModRemovalRecord {
  if (value === null || typeof value !== 'object') return false;

  const record = value as Partial<ModRemovalRecord>;
  return (
    typeof record.id === 'string' &&
    (record.kind === 'post' || record.kind === 'comment') &&
    typeof record.body === 'string' &&
    typeof record.author === 'string' &&
    typeof record.authorCommentKarma === 'number' &&
    typeof record.authorPostKarma === 'number' &&
    typeof record.authorAccountAge === 'number' &&
    (record.authorId === undefined || typeof record.authorId === 'string') &&
    (record.authorIsMod === undefined || typeof record.authorIsMod === 'boolean') &&
    (record.authorIsGold === undefined || typeof record.authorIsGold === 'boolean') &&
    (record.removalReason === undefined || typeof record.removalReason === 'string') &&
    (record.synthetic === undefined || typeof record.synthetic === 'boolean') &&
    typeof record.moderator === 'string' &&
    typeof record.removedAt === 'number' &&
    (record.signalSource === undefined ||
      record.signalSource === 'resolved' ||
      record.signalSource === 'snapshot' ||
      record.signalSource === 'fallback')
  );
}

function isSyntheticTrainingRemoval(record: ModRemovalRecord): boolean {
  const title = record.title ?? '';
  return (
    record.synthetic === true ||
    record.removalReason === 'AutoMod Studio generated training data' ||
    record.author === 'automod-studio-seed' ||
    title.includes('[AutoMod Studio seed]') ||
    record.body.includes('[AutoMod Studio seed]')
  );
}

export function filterRealRemovalRecords(records: ModRemovalRecord[]): ModRemovalRecord[] {
  return records.filter((record) => !isSyntheticTrainingRemoval(record));
}

export async function getModRemovalRecords(subredditName: string): Promise<ModRemovalRecord[]> {
  const raw = await redis.get(removalsKey(subredditName)).catch(() => null);
  const parsed = parseJson<unknown[]>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isModRemovalRecord);
}

export async function appendModRemovalRecord(
  subredditName: string,
  record: ModRemovalRecord
): Promise<ModRemovalRecord[]> {
  const existing = await getModRemovalRecords(subredditName);
  const next = [record, ...existing.filter((entry) => entry.id !== record.id)].slice(0, MAX_REMOVALS);
  await redis.set(removalsKey(subredditName), JSON.stringify(next));
  return next;
}

export async function writeModRemovalRecords(
  subredditName: string,
  records: ModRemovalRecord[]
): Promise<void> {
  await redis.set(removalsKey(subredditName), JSON.stringify(records.slice(0, MAX_REMOVALS)));
}

export async function getFalsePositiveIds(subredditName: string): Promise<string[]> {
  const raw = await redis.get(falsePositivesKey(subredditName)).catch(() => null);
  const parsed = parseJson<unknown[]>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

export async function addFalsePositiveId(
  subredditName: string,
  itemId: string
): Promise<string[]> {
  const existing = await getFalsePositiveIds(subredditName);
  if (existing.includes(itemId)) return existing;

  const next = [itemId, ...existing];
  await redis.set(falsePositivesKey(subredditName), JSON.stringify(next));
  return next;
}

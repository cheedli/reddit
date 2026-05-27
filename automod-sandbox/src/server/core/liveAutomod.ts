import { reddit, redis } from '@devvit/web/server';
import type { LiveRuleState } from '../../shared/api.js';
import { formatError } from './errors.js';

const AUTOMOD_PAGE = 'config/automoderator';
const AUTOMOD_DRAFT_PAGE = 'automod_studio_draft';
const CLEARED_DRAFT_CONTENT = '# AutoMod Studio draft cleared\n';
const DRAFT_KEY_PREFIX = 'automod-sandbox:automod-draft:';
const ROLLBACK_KEY_PREFIX = 'automod-sandbox:automod-rollback:';

type LiveSnapshot = Pick<
  LiveRuleState,
  'yaml' | 'exists' | 'revisionId' | 'revisionDate' | 'revisionReason'
>;

type DraftRecord = {
  yaml: string;
  updatedAt: number;
};

type RollbackRecord = {
  existed: boolean;
  yaml: string | null;
  revisionId: string | null;
  revisionDate: number | null;
  savedAt: number;
};

type ApplyMode = 'replace' | 'append';

function draftKey(subredditName: string): string {
  return `${DRAFT_KEY_PREFIX}${subredditName.toLowerCase()}`;
}

function rollbackKey(subredditName: string): string {
  return `${ROLLBACK_KEY_PREFIX}${subredditName.toLowerCase()}`;
}

function parseJsonRecord<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sameYaml(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? '').trim() === (right ?? '').trim();
}

function splitAutomodDocuments(yaml: string): string[] {
  return yaml
    .split(/^(?:---|\.\.\.)\s*$/m)
    .map((section) => section.trim())
    .filter(Boolean);
}

function appendMissingAutomodDocuments(
  baseYaml: string | null | undefined,
  incomingYaml: string | null | undefined
): string {
  const baseDocuments = splitAutomodDocuments(baseYaml ?? '');
  const seen = new Set(baseDocuments.map((document) => document.trim()));
  const incomingDocuments = splitAutomodDocuments(incomingYaml ?? '').filter((document) => {
    const normalized = document.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  const documents = [...baseDocuments, ...incomingDocuments];
  return documents.length ? `${documents.join('\n\n---\n')}\n` : '';
}

function normalizeAutomodYamlForReddit(yaml: string): string {
  return yaml
    .replace(/^(\s*)post_karma(\s*:)/gm, '$1link_karma$2')
    .replace(/^(\s*)is_mod(\s*:)/gm, '$1is_moderator$2');
}

async function getRedisDraftRecord(subredditName: string): Promise<DraftRecord | null> {
  const record = parseJsonRecord<DraftRecord>(await redis.get(draftKey(subredditName)).catch(() => null));
  if (!record || typeof record.yaml !== 'string' || typeof record.updatedAt !== 'number') {
    return null;
  }
  return record;
}

async function getDraftRecord(subredditName: string): Promise<DraftRecord | null> {
  try {
    const pages = await reddit.getWikiPages(subredditName);
    if (pages.includes(AUTOMOD_DRAFT_PAGE)) {
      const page = await reddit.getWikiPage(subredditName, AUTOMOD_DRAFT_PAGE);
      if (!page.content.trim() || page.content.trim() === CLEARED_DRAFT_CONTENT.trim()) {
        return null;
      }
      return {
        yaml: page.content,
        updatedAt: page.revisionDate.getTime(),
      };
    }
  } catch {
    // Fall back to the legacy Redis draft below.
  }

  return getRedisDraftRecord(subredditName);
}

async function writeDraftRecord(
  subredditName: string,
  yaml: string,
  reason?: string
): Promise<DraftRecord> {
  const record: DraftRecord = {
    yaml,
    updatedAt: Date.now(),
  };

  try {
    const pages = await reddit.getWikiPages(subredditName);
    if (pages.includes(AUTOMOD_DRAFT_PAGE)) {
      await reddit.updateWikiPage({
        subredditName,
        page: AUTOMOD_DRAFT_PAGE,
        content: yaml,
        reason,
      });
    } else {
      await reddit.createWikiPage({
        subredditName,
        page: AUTOMOD_DRAFT_PAGE,
        content: yaml,
        reason,
      });
    }
  } catch (error) {
    await redis.set(draftKey(subredditName), JSON.stringify(record)).catch(() => undefined);
    throw new Error(`Failed to save draft to Reddit wiki page ${AUTOMOD_DRAFT_PAGE}: ${formatError(error)}`);
  }

  await redis.set(draftKey(subredditName), JSON.stringify(record)).catch(() => undefined);
  return record;
}

async function clearDraftRecord(subredditName: string): Promise<void> {
  try {
    const pages = await reddit.getWikiPages(subredditName);
    if (pages.includes(AUTOMOD_DRAFT_PAGE)) {
      await reddit.updateWikiPage({
        subredditName,
        page: AUTOMOD_DRAFT_PAGE,
        content: CLEARED_DRAFT_CONTENT,
        reason: 'AutoMod Studio draft applied live',
      });
    }
  } catch (error) {
    console.error('[live-automod] failed to clear draft wiki page:', error);
  }

  await redis.del?.(draftKey(subredditName)).catch(() => undefined);
}

async function getRollbackRecord(subredditName: string): Promise<RollbackRecord | null> {
  const record = parseJsonRecord<RollbackRecord>(
    await redis.get(rollbackKey(subredditName)).catch(() => null)
  );
  if (
    !record ||
    typeof record.existed !== 'boolean' ||
    typeof record.savedAt !== 'number' ||
    (record.yaml !== null && typeof record.yaml !== 'string') ||
    (record.revisionId !== null && typeof record.revisionId !== 'string') ||
    (record.revisionDate !== null && typeof record.revisionDate !== 'number')
  ) {
    return null;
  }
  return record;
}

async function writeRollbackRecord(subredditName: string, snapshot: LiveSnapshot): Promise<void> {
  const record: RollbackRecord = {
    existed: snapshot.exists,
    yaml: snapshot.yaml,
    revisionId: snapshot.revisionId,
    revisionDate: snapshot.revisionDate,
    savedAt: Date.now(),
  };
  await redis.set(rollbackKey(subredditName), JSON.stringify(record));
}

async function getLiveSnapshot(subredditName: string): Promise<LiveSnapshot> {
  try {
    const pages = await reddit.getWikiPages(subredditName);
    if (!pages.includes(AUTOMOD_PAGE)) {
      return {
        yaml: null,
        exists: false,
        revisionId: null,
        revisionDate: null,
        revisionReason: null,
      };
    }

    const page = await reddit.getWikiPage(subredditName, AUTOMOD_PAGE);
    return {
      yaml: page.content,
      exists: true,
      revisionId: page.revisionId,
      revisionDate: page.revisionDate.getTime(),
      revisionReason: page.revisionReason || null,
    };
  } catch (error) {
    throw new Error(`Failed to read live AutoMod: ${formatError(error)}`);
  }
}

export async function getLiveRuleState(subredditName: string): Promise<LiveRuleState> {
  const [snapshot, draft, rollback] = await Promise.all([
    getLiveSnapshot(subredditName),
    getDraftRecord(subredditName),
    getRollbackRecord(subredditName),
  ]);

  return {
    ...snapshot,
    draftYaml: draft?.yaml ?? null,
    draftUpdatedAt: draft?.updatedAt ?? null,
    rollbackAvailable: Boolean(rollback && (rollback.revisionId || rollback.existed)),
  };
}

export async function saveLiveDraft(
  subredditName: string,
  yaml: string
): Promise<{ live: LiveRuleState; savedAt: number }> {
  if (!yaml.trim()) {
    throw new Error('Cannot save empty AutoMod YAML.');
  }

  const currentDraft = await getDraftRecord(subredditName);
  const nextYaml = currentDraft?.yaml?.trim()
    ? appendMissingAutomodDocuments(currentDraft.yaml, yaml)
    : yaml;
  const draft = await writeDraftRecord(
    subredditName,
    nextYaml,
    'AutoMod Studio draft save'
  );
  return {
    live: await getLiveRuleState(subredditName),
    savedAt: draft.updatedAt,
  };
}

export async function applyLiveRules(
  subredditName: string,
  yaml: string,
  reason?: string,
  mode: ApplyMode = 'replace'
): Promise<{ live: LiveRuleState; applied: boolean; message: string }> {
  if (!yaml.trim()) {
    throw new Error('Cannot apply empty AutoMod YAML.');
  }

  const current = await getLiveSnapshot(subredditName);
  const draft = await getDraftRecord(subredditName);
  const mergedYaml =
    mode === 'append'
      ? appendMissingAutomodDocuments(current.yaml, yaml)
      : yaml;
  const nextYaml = normalizeAutomodYamlForReddit(mergedYaml);

  if (current.exists && current.yaml === nextYaml) {
    if (sameYaml(draft?.yaml, yaml)) {
      await clearDraftRecord(subredditName);
    }
    return {
      live: await getLiveRuleState(subredditName),
      applied: false,
      message: 'Live AutoMod already matches the editor.',
    };
  }

  await writeRollbackRecord(subredditName, current);

  try {
    if (current.exists) {
      await reddit.updateWikiPage({
        subredditName,
        page: AUTOMOD_PAGE,
        content: nextYaml,
        reason,
      });
    } else {
      await reddit.createWikiPage({
        subredditName,
        page: AUTOMOD_PAGE,
        content: nextYaml,
        reason,
      });
    }
  } catch (error) {
    const message = formatError(error);
    const hint = message.includes('HTTP 415')
      ? ' Reddit returned HTTP 415, which often means the AutoModerator YAML was rejected. Check for invalid YAML or unsupported AutoModerator syntax.'
      : '';
    throw new Error(`Failed to apply live AutoMod: ${message}${hint}`);
  }

  if (sameYaml(draft?.yaml, yaml)) {
    await clearDraftRecord(subredditName);
  }

  return {
    live: await getLiveRuleState(subredditName),
    applied: true,
    message:
      mode === 'append' && current.exists
        ? 'Added the draft rule to live AutoMod.'
        : current.exists
          ? 'Applied the editor rules to live AutoMod.'
          : 'Created the live AutoMod config and applied the editor rules.',
  };
}

export async function rollbackLiveRules(
  subredditName: string,
  reason?: string
): Promise<{ live: LiveRuleState; rolledBack: boolean; message: string }> {
  const rollback = await getRollbackRecord(subredditName);
  if (!rollback) {
    throw new Error('No rollback snapshot is available yet.');
  }
  if (!rollback.existed && !rollback.revisionId) {
    throw new Error('Rollback is unavailable because no live AutoMod page existed before apply.');
  }

  const current = await getLiveSnapshot(subredditName);
  await writeRollbackRecord(subredditName, current);

  try {
    if (rollback.revisionId && current.exists) {
      await reddit.revertWikiPage(subredditName, AUTOMOD_PAGE, rollback.revisionId);
    } else if (rollback.yaml !== null) {
      if (current.exists) {
        await reddit.updateWikiPage({
          subredditName,
          page: AUTOMOD_PAGE,
          content: rollback.yaml,
          reason,
        });
      } else {
        await reddit.createWikiPage({
          subredditName,
          page: AUTOMOD_PAGE,
          content: rollback.yaml,
          reason,
        });
      }
    } else {
      throw new Error('Rollback snapshot is missing the previous AutoMod content.');
    }
  } catch (error) {
    throw new Error(`Failed to roll back live AutoMod: ${formatError(error)}`);
  }

  return {
    live: await getLiveRuleState(subredditName),
    rolledBack: true,
    message: 'Rolled live AutoMod back to the previous saved revision.',
  };
}

import { Hono } from 'hono';
import { context } from '@devvit/web/server';
import type { OnModActionRequest, TriggerResponse } from '@devvit/web/shared';
import { appendModRemovalRecord } from '../core/moderationMemory.js';
import { buildRemovalRecord } from '../core/removalSignals.js';

export const triggers = new Hono();

const TRACKED_ACTIONS = new Set(['removepost', 'spampost', 'removecomment', 'spamcomment']);

triggers.post('/on-app-install', async (c) => {
  return c.json<TriggerResponse>(
    { status: 'success', message: 'Install complete. No test content created.' },
    200
  );
});

triggers.post('/on-app-upgrade', async (c) => {
  return c.json<TriggerResponse>(
    { status: 'success', message: 'Upgrade complete. No test content created.' },
    200
  );
});

// Track mod removals - powers the auto-suggest feature.
triggers.post('/on-mod-action', async (c) => {
  try {
    const input = await c.req.json<OnModActionRequest>();
    if (!TRACKED_ACTIONS.has(input.action ?? '')) {
      return c.json<TriggerResponse>({ status: 'success', message: 'Action not tracked' }, 200);
    }

    const subredditName = context.subredditName ?? '';
    if (!subredditName) {
      return c.json<TriggerResponse>({ status: 'success', message: 'No subreddit in context' }, 200);
    }

    const record = await buildRemovalRecord(subredditName, input);
    if (!record) {
      return c.json<TriggerResponse>({ status: 'success', message: 'No target' }, 200);
    }

    await appendModRemovalRecord(subredditName, record);

    return c.json<TriggerResponse>(
      { status: 'success', message: `Recorded ${input.action} on ${record.id}` },
      200
    );
  } catch (error) {
    console.error(`[triggers] on-mod-action error:`, error);
    return c.json<TriggerResponse>({ status: 'error', message: String(error) }, 400);
  }
});

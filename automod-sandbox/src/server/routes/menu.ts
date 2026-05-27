import { Hono } from 'hono';
import { context, reddit, redis } from '@devvit/web/server';
import type { UiResponse } from '@devvit/web/shared';
import { formatError } from '../core/errors.js';
import { getHistoryDaysSetting, loadSandboxHistory } from '../core/history.js';

export const menu = new Hono();

const SANDBOX_POST_KEY_PREFIX = 'automod-sandbox:post:';

function sandboxPostKey(subredditName: string): string {
  return `${SANDBOX_POST_KEY_PREFIX}${subredditName.toLowerCase()}`;
}

function redditPostUrl(subredditName: string, postId: string): string {
  return `https://www.reddit.com/r/${subredditName}/comments/${postId.replace(/^t3_/, '')}/`;
}

menu.post('/open-studio', async (c) => {
  const sub = context.subredditName ?? '';
  if (!sub) {
    return c.json<UiResponse>({ showToast: 'No subreddit in context.' }, 400);
  }

  try {
    const existingPostId = await redis.get(sandboxPostKey(sub));
    if (existingPostId) {
      return c.json<UiResponse>({
        navigateTo: redditPostUrl(sub, existingPostId),
        showToast: 'Opening AutoMod Studio.',
      });
    }

    const post = await reddit.submitCustomPost({
      subredditName: sub,
      title: `AutoMod Studio - r/${sub}`,
      entry: 'default',
      textFallback: {
        text: 'Open this post on reddit.com to use AutoMod Studio.',
      },
    });

    await redis.set(sandboxPostKey(sub), post.id);

    return c.json<UiResponse>({
      navigateTo: post.permalink,
      showToast: 'Created AutoMod Studio for this subreddit.',
    });
  } catch (e) {
    console.error('[menu/open-studio] error:', e);
    return c.json<UiResponse>({ showToast: `Error: ${formatError(e)}` }, 500);
  }
});

menu.post('/fetch-history', async (c) => {
  const body: { subredditName?: string } = await c.req
    .json<{ subredditName?: string }>()
    .catch(() => ({ subredditName: undefined }));
  const sub = body.subredditName || context.subredditName || '';
  if (!sub) return c.json({ status: 'error', message: 'No subreddit in context' }, 400);

  console.log(`[menu/fetch-history] fetching posts for r/${sub}...`);

  try {
    const historyDays = await getHistoryDaysSetting();
    const history = await loadSandboxHistory(sub, historyDays, { force: true });
    console.log(`[menu/fetch-history] stored ${history.items.length} posts (${historyDays}d window)`);
    return c.json({ status: 'ok', count: history.items.length });
  } catch (e) {
    console.error('[menu/fetch-history] reddit error:', e);
    return c.json({ status: 'error', message: formatError(e) }, 500);
  }
});

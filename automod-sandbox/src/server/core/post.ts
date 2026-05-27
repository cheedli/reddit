import { context, reddit } from '@devvit/web/server';

export const createPost = async () => {
  const subredditName = context.subredditName ?? '';
  return await reddit.submitCustomPost({
    title: `AutoMod Sandbox - r/${subredditName}`,
    subredditName,
  });
};

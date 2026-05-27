import type { Item } from '../engine/types.js';

// In-memory history cache for the lifetime of the server process.

export const store: {
  items: Item[];
  fetchedAt: number | null;
  historySubreddit: string | null;
  historyDays: number | null;
} = {
  items: [],
  fetchedAt: null,
  historySubreddit: null,
  historyDays: null,
};

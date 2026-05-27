/* eslint-disable react-refresh/only-export-components */
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { context, requestExpandedMode } from '@devvit/web/client';
import { BoltIcon } from './icons.js';

const Splash = () => (
  <div className="flex flex-col items-center justify-center h-full gap-4 bg-[#dae0e6] text-[#1c1c1c] px-4" style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif' }}>
    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white border border-[#ccc]">
      <BoltIcon className="h-7 w-7 text-[#ff4500]" />
    </div>
    <h1 className="text-lg font-bold">AutoMod Studio</h1>
    <p className="text-sm text-[#545452] text-center max-w-[240px]">
      Draft, replay, and safely ship AutoMod rules against recent subreddit history.
    </p>
    <button
      className="mt-1 bg-[#ff4500] hover:bg-[#e03d00] text-white px-5 py-2 rounded-full text-sm font-bold transition-colors cursor-pointer"
      onClick={(e) => requestExpandedMode(e.nativeEvent, 'game')}
    >
      Open Studio
    </button>
    <p className="text-xs text-[#878a8c]">r/{context.subredditName}</p>
  </div>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Splash />
  </StrictMode>
);

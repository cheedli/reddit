# AutoMod Studio — Devpost "About the Project"

## Inspiration

There's a gap in the moderator toolkit that every experienced Reddit mod has felt: **there is no way to test an AutoMod rule before it goes live.**

You write YAML. You ship it. You watch what breaks.

The current best practice — recommended in Reddit's own official mod tips — is to create a private subreddit and post from alt accounts just to see if your rules fire correctly. It works, but it's slow, clunky, and completely disconnected from your real community's content. Most mods just ship and hope.

This isn't a niche complaint. In 2022, researchers at a top academic institution thought this problem was serious enough to dedicate a full study to it. Their paper — [ModSandbox, published at CHI 2023](https://arxiv.org/pdf/2210.09569), one of the most prestigious human-computer interaction conferences in the world — documented what Reddit moderators actually do: they use **fake accounts to submit test posts** to their own communities, just to verify their rules work. They found that moderators had *"no way to estimate the actual effects of a rule in advance"* and that this caused real harm — over-broad rules silently nuking legitimate posts, under-broad rules missing obvious spam, mods afraid to touch their AutoMod config at all because the feedback loop was so painful.

ModSandbox proved the concept. It was a research prototype, presented at a conference, never deployed. Moderators read the paper and went back to their alt accounts.

We built the thing the researchers proved was needed. AutoMod Studio is that tool — production-ready, installed directly inside Reddit's mod tools, available to any moderator today.

---

## What it does

AutoMod Studio is a full moderator workbench that lives inside Reddit's mod tools. Write an AutoMod YAML rule — or just describe what you want in plain English — and watch it replay against your subreddit's real post and comment history in real time. Every match is explained: which condition fired, what text triggered it, what action *would have* been taken. No guessing. No production casualties.

But it's more than a replay tool:

**Live Diff Mode** puts your current live AutoMod config side-by-side against your proposed changes — three panels showing what only the new rules catch, what only the old rules catch, and where the action changes. It's the kind of view you'd want before touching rules on a 500k-member sub.

**Auto-Suggested Rules** watches your manual removals over time. Spot a pattern? Twenty posts removed from new accounts linking to the same domain? The app surfaces a scored YAML rule — precision, recall, false-positive risk — before you ever have to ask for it.

**False Positive Feedback** lets you thumbs-down any result. The suggestion engine learns, tightens, and stops recommending the same mistake twice.

**No API key required.** The entire core works locally — keyword detection, domain blocks, account age gates, karma thresholds — all translated to YAML without touching an LLM. The AI layer is an upgrade, not a crutch.

---

## How we built it

The architecture has one iron rule: **the evaluation engine touches zero Reddit APIs.**

`src/engine/` is pure TypeScript. It takes a parsed AutoMod rule and an item, returns a structured match result, and has no idea Devvit exists. This kept it fully unit-testable (39 tests) and fast enough to evaluate thousands of items in under 100ms — which is why the "Evaluated 3,421 items in 87ms" counter in the UI isn't a lie.

The server is a Hono app inside Devvit's Node runtime, handling history fetching, Redis caching, live AutoMod draft/apply/rollback, and a multi-provider LLM adapter (OpenAI, Anthropic, Gemini). The client is React 19 + Tailwind CSS 4 with Monaco Editor — the same editor engine that powers VS Code — for YAML editing with full syntax highlighting.

Live evaluation runs on a 400ms debounce. Type a rule, wait a beat, results update. The whole loop feels instant because the engine is doing real work fast, not faking it with a spinner.

---

## Challenges we ran into

**Reddit's API hard-caps at 1,000 items.** Full stop. "Test against the last 30 days" is marketing copy, not a feature you can build — active subs hit 1,000 posts in days. We adapted: the app fetches up to 1,000 posts and comments, labels the actual coverage honestly, and uses a PostCreate trigger to build a rolling cache over the app's install lifetime. The longer it's installed, the better the history gets.

**Devvit's outbound fetch allowlist doesn't include `api.anthropic.com`.** The original brief called for Anthropic exclusively. We discovered this the hard way, pivoted to OpenAI and Gemini, and then — because a mod shouldn't need a $20/month API subscription to test a spam filter — built the entire local translation layer. That pivot produced the better architecture.

**AutoMod's semantics are subtler than the docs let on.** `includes-word` is word-boundary aware. `regex` needs validation at parse time or it silently matches nothing. Negation via `~` prefix works differently from what you'd expect if you're coming from other filter systems. Getting these right meant reading community-written AutoMod explainers, not just the official reference.

---

## Accomplishments that we're proud of

The suggestion engine scoring surprised us. Surfacing a rule candidate is easy. Surfacing one that tells you *"this would catch 19 of your last 23 manual removals with a 4% false-positive rate"* — and being right about it — took real work. Watching it recommend a rule that a moderator would have written themselves, unprompted, is the moment the app stops feeling like a demo and starts feeling like a tool.

We're also proud of the 39-test engine suite. Boring to write. Essential to have. Every condition type, every text modifier, every edge case in multi-rule YAML files. The engine doesn't lie, and the tests prove it.

---

## What we learned

Devvit's `postMessage` boundary between the React frontend and the server backend looks simple until you're passing complex types across it and wondering why your TypeScript isn't catching the mismatch. Shared types in `src/shared/api.ts` solved it — one source of truth for the entire HTTP contract.

We also learned that honesty beats completeness in a power tool. AutoMod has dozens of conditions. We support ~15 of them extremely well, and we surface a parser warning for anything we don't support rather than silently ignoring it. Moderators trust a tool that tells them what it can't do.

---

## What's next for AutoMod Sandbox

The 2017 thread was about testing. The next problem is *sharing*.

Right now, every moderator who figures out a good spam-detection rule keeps it to themselves. There's no AutoMod rule library, no way to say "here's what's working on r/gaming, adapted for your sub." That's a distribution problem AutoMod Studio is in a unique position to solve — because it already has the evaluation engine, the history fetcher, and the diff viewer. A community rule library with one-click preview-against-your-own-history is a natural next step.

Beyond that: write-back support (push a validated rule directly to `config/automoderator` with a diff confirmation), comment-level condition support, and eventually — if the community wants it — a shared false-positive dataset that makes the suggestion engine smarter for everyone.

The sandbox is open. The rules are yours to write.

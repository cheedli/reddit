# AutoMod Studio

AutoMod Studio is a Devvit moderator tool for drafting, replaying, and safely applying Reddit AutoModerator rules.

It is built for the common moderation loop:

1. Load recent posts and comments from a subreddit.
2. Draft a rule in YAML or plain English.
3. Replay the rule against recent history and inspect matches.
4. Mark false positives so future suggestions learn what to avoid.
5. Compare proposed rules against the live `config/automoderator` page before applying.

## What It Does

- Replays supported AutoMod YAML against recent subreddit history.
- Shows parser warnings for risky or partially unsupported rules.
- Loads both posts and comments with author-age and karma signals.
- Learns from manual moderator removals and known false positives.
- Scores rule suggestions with precision-style metrics before surfacing them.
- Supports live draft, apply, and rollback for `config/automoderator`.
- Works without an OpenAI key for common rule templates and heuristic suggestions.

## No-Key Mode

OpenAI is optional.

Without a key, the app still provides:

- Local plain-English translation for common moderation patterns:
  - keywords
  - domains
  - account age
  - karma thresholds
  - edited state
  - report thresholds
- Heuristic rule suggestions scored against recent history
- Parser warnings
- Live diff, draft, apply, and rollback

With a key, the app adds:

- Freer plain-English translation
- Extra LLM-generated suggestion candidates that are still linted and scored locally

## Supported AutoMod Subset

The evaluator currently supports a deliberate subset of AutoModerator syntax:

- `type`
- `action`
- `action_reason`
- `title`
- `body`
- `title+body`
- `domain`
- `author.comment_karma`
- `author.post_karma`
- `author.account_age`
- `author.name`
- `author.flair_text`
- `author.is_gold`
- `author.is_moderator`
- `is_edited`
- `reports`

Supported text modifiers:

- `includes-word`
- `includes`
- `starts-with`
- `ends-with`
- `full-exact`
- `regex`

Unsupported fields are surfaced as warnings instead of being silently ignored.

## Dev Setup

Requirements:

- Node `>=22.2.0`
- Devvit CLI access through `npx devvit`

Install:

```bash
npm install
```

Run locally:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Upload:

```bash
npx devvit upload
```

## Testing

Type-check:

```bash
npm run type-check
```

Lint:

```bash
npm run lint
```

Tests:

```bash
npm run test
```

## Submission Notes

For demos and judging, the strongest flow is:

1. Load recent subreddit history.
2. Show a plain-English rule generated in local template mode.
3. Mark a false positive and refresh suggestions.
4. Open Suggestions to show confidence, precision, recall, and false-positive risk.
5. Use Diff Mode and apply/rollback against live AutoMod.

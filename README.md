# AutoMod Studio

> Mods have asked for an AutoMod testing sandbox since 2017. It still doesn't exist. This is it.

AutoMod Studio is a Reddit mod tool built on [Devvit](https://developers.reddit.com/docs) that lets moderators safely draft, test, and refine AutoModerator rules — without ever touching production.

---

## The Problem

Reddit moderators have wanted a way to test AutoMod rules before deploying them [since at least 2017](https://www.reddit.com/r/AutoModerator/comments/7299pw/sandbox_or_testing_tool_for_automoderator/). The current workflow: create a private test sub, post from alt accounts, ship to production and hope. AutoMod Studio replaces all of that.

---

## What It Does

Write or paste an AutoMod YAML rule (or describe it in plain English), and instantly see what it *would have* flagged across your subreddit's recent history — before a single post is touched.

**Core features:**

- **Live rule replay** — evaluates YAML against cached subreddit history in real time as you type, with a debounced engine that processes thousands of items in milliseconds
- **Plain-English to YAML** — describe a rule in plain English and get valid AutoMod YAML back (powered by OpenAI; works without a key using local templates)
- **Diff mode** — compare your current live AutoMod rules against a proposed revision; see exactly what changes, what's newly caught, and what's dropped
- **Auto-suggested rules** — learns from your team's manual removal patterns and surfaces rule candidates with precision/recall metrics
- **False-positive feedback** — mark results that shouldn't be flagged; the app tightens its suggestions accordingly
- **Live draft, apply, and rollback** — manage your `config/automoderator` wiki page directly from the UI

---

## Supported AutoMod Conditions

| Condition | Modifiers |
|---|---|
| `type` | — |
| `title`, `body`, `title+body` | `includes-word`, `includes`, `starts-with`, `ends-with`, `full-exact`, `regex` |
| `author.comment_karma` | comparison operators |
| `author.post_karma` | comparison operators |
| `author.account_age` | comparison operators |
| `author.name` | — |
| `author.flair_text` | — |
| `author.is_gold` | — |
| `author.is_moderator` | — |
| `domain` | — |
| `is_edited` | — |
| `reports` | comparison operators |

Unsupported fields are surfaced as parser warnings — never silently ignored.

---

## No API Key Required

The app works without an OpenAI key. Without one you get:

- Local plain-English translation for common patterns (keywords, domains, account age, karma, edited state, report thresholds)
- Heuristic rule suggestions scored against recent history
- Full diff, draft, apply, and rollback

With an OpenAI key you additionally get free-form plain-English translation and LLM-generated suggestion candidates (still linted and scored locally before surfacing).

---

## Tech Stack

| Layer | Tech |
|---|---|
| Platform | [Devvit](https://developers.reddit.com/docs) 0.12.x |
| Language | TypeScript (strict) |
| Frontend | React 19 + Vite + Tailwind CSS |
| Editor | Monaco (`@monaco-editor/react`) |
| Backend | Devvit Web app (Hono server) |
| State | Devvit Redis |
| YAML parsing | `js-yaml` |
| Tests | Vitest |

---

## Install & Setup

**Requirements:** Node `>=22.2.0`, Devvit CLI

```bash
npm install
```

**Run locally (playtest on a test sub):**

```bash
npm run dev
```

**Build:**

```bash
npm run build
```

**Upload to Reddit:**

```bash
npx devvit upload
```

**Full deploy (type-check + lint + test + upload + publish):**

```bash
npm run launch
```

---

## Configuration

After installing the app on your subreddit, open **App Settings**:

- **OpenAI API key** *(optional)* — enables free-form plain-English rule translation
- **Days of history to load** — default 30, max 90

API keys are stored in Devvit's encrypted settings — never committed to code, never visible to other users.

---

## Testing

```bash
npm run type-check   # TypeScript strict check
npm run lint         # ESLint
npm run test         # Vitest unit tests (engine + server)
```

The rule evaluation engine (`src/engine/`) has no Devvit dependencies and is fully unit-tested.

---

## Project Structure

```
automod-sandbox/
├── src/
│   ├── engine/          # Pure rule evaluation — no Devvit imports
│   │   ├── parser.ts
│   │   ├── evaluator.ts
│   │   └── conditions/
│   ├── server/          # Devvit backend (Hono + Redis)
│   │   ├── core/
│   │   └── routes/
│   ├── client/          # React frontend
│   └── shared/          # Types shared between server and client
└── devvit.json
```

---

## Competing Apps

AutoMod Studio is distinct from existing Reddit apps:

- **AutoMod Next** — rule editor with no sandbox/replay
- **Automod Mirror** — mirrors rules across subs, no testing
- **AI Automod** — AI suggestions only, no replay engine

---

## Links

- [Devvit docs](https://developers.reddit.com/docs)
- [AutoMod official docs](https://support.reddithelp.com/hc/en-us/articles/15484574206484-Automoderator)
- [The 2017 sandbox request thread](https://www.reddit.com/r/AutoModerator/comments/7299pw/sandbox_or_testing_tool_for_automoderator/)
- [Hackathon](https://mod-tools-migration.devpost.com/)

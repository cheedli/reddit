/* eslint-disable react-refresh/only-export-components */
import './index.css';

import {
  StrictMode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { navigateTo } from '@devvit/web/client';
import type {
  ApplyLiveRulesResponse,
  DevRemoveTrainingItemsResponse,
  FetchHistoryResponse,
  InitResponse,
  LiveRuleState,
  LiveRulesResponse,
  RollbackLiveRulesResponse,
  RuleSuggestion,
  SaveDraftResponse,
  SuggestionsResponse,
  TranslateResponse,
} from '../shared/api.js';
import type { Item, MatchResult, ParseWarning, ParsedRule, TextCondition, ComparisonValue } from '../engine/types.js';
import { parseRules } from '../engine/parser.js';
import { evaluateAll } from '../engine/evaluator.js';
import {
  BoltIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  SlashCircleIcon,
  SparkIcon,
  TrayIcon,
  XIcon,
} from './icons.js';
import {
  THEMES,
  type ThemeId,
  type Theme,
  applyTheme,
} from './themes.js';

loader.config({ monaco });

// -- Default YAML starter --------------------------------------------------

const DEFAULT_YAML = `# AutoMod Sandbox - edit this rule and watch results update live.
# Separate multiple rules with --- on its own line.
# Reference: https://support.reddithelp.com/hc/en-us/articles/15484574206484

type: submission
title:
  includes-word:
    - spam
    - scam
    - "buy now"
action: remove
action_reason: Matched spam keywords in title
`;

// -- Theme context ---------------------------------------------------------

const ThemeContext = createContext<{
  theme: Theme;
  setThemeId: (id: ThemeId) => void;
}>({
  theme: THEMES[0]!,
  setThemeId: () => {},
});

function useTheme() {
  return useContext(ThemeContext);
}

// -- Debounce hook ---------------------------------------------------------

function useDebounce<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

async function readApiJson<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const body = text.trim().slice(0, 300) || 'Empty response body';
    throw new Error(`Server returned non-JSON response (${resp.status}): ${body}`);
  }
}

function redditUrl(permalink: string): string {
  return new URL(permalink, 'https://www.reddit.com').toString();
}

// -- Action badge ----------------------------------------------------------

function ActionBadge({ action }: { action: string | null }) {
  const cls = action === 'remove'
    ? 't-badge t-badge-remove'
    : action === 'filter'
      ? 't-badge t-badge-filter'
      : action === 'report'
        ? 't-badge t-badge-report'
        : action === 'approve'
          ? 't-badge t-badge-approve'
          : 't-badge t-badge-neutral';
  return <span className={cls}>{action ?? '?'}</span>;
}

function textConditionSummary(label: string, condition?: TextCondition): string | null {
  if (!condition) return null;
  const values = condition.values.slice(0, 3).join(', ');
  const more = condition.values.length > 3 ? ` +${condition.values.length - 3}` : '';
  return `${label} ${condition.modifier}: ${values}${more}`;
}

function comparisonSummary(label: string, value?: ComparisonValue): string | null {
  if (!value) return null;
  return `${label} ${value.operator} ${value.value}${value.unit ? ` ${value.unit}` : ''}`;
}

function ruleConditionSummaries(rule: ParsedRule): string[] {
  return [
    textConditionSummary('title', rule.title),
    textConditionSummary('body', rule.body),
    textConditionSummary('title+body', rule.titleAndBody),
    textConditionSummary('domain', rule.domain),
    textConditionSummary('flair', rule.flairText),
    textConditionSummary('author name', rule.author?.name),
    textConditionSummary('author flair', rule.author?.flairText),
    comparisonSummary('comment karma', rule.author?.commentKarma),
    comparisonSummary('post karma', rule.author?.postKarma),
    comparisonSummary('account age', rule.author?.accountAge),
    comparisonSummary('reports', rule.reports),
    rule.isEdited !== undefined ? `edited: ${rule.isEdited ? 'yes' : 'no'}` : null,
    rule.author?.isGold !== undefined ? `premium: ${rule.author.isGold ? 'yes' : 'no'}` : null,
    rule.author?.isMod !== undefined ? `moderator: ${rule.author.isMod ? 'yes' : 'no'}` : null,
  ].filter((entry): entry is string => Boolean(entry));
}

// -- Rule warnings panel ---------------------------------------------------

function RuleWarningsPanel({
  warnings,
  unsupportedFields,
}: {
  warnings: ParseWarning[];
  unsupportedFields: string[];
}) {
  if (warnings.length === 0 && unsupportedFields.length === 0) return null;
  return (
    <div className="t-alert-warn shrink-0 mx-0 rounded-none border-x-0 border-t-0 text-xs">
      <div className="font-medium mb-1">
        Rule warnings {warnings.length > 0 && `(${warnings.length})`}
      </div>
      {warnings.slice(0, 6).map((w, i) => (
        <div key={`${w.ruleIndex}-${w.code}-${i}`} className="leading-5">
          Rule {w.ruleIndex + 1}: {w.message}
        </div>
      ))}
      {unsupportedFields.length > 0 && (
        <div className="mt-1">
          Unsupported fields:{' '}
          <span className="font-mono">{unsupportedFields.join(', ')}</span>
        </div>
      )}
    </div>
  );
}

// -- Results panel ---------------------------------------------------------

function ResultsPanel({
  results,
  falsePositives,
  onFP,
}: {
  results: MatchResult[];
  falsePositives: Set<string>;
  onFP: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const [renderedAt] = useState(() => Date.now());

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full t-text-3 gap-2">
        <CheckCircleIcon className="h-6 w-6" />
        <p className="text-sm">No matches yet.</p>
      </div>
    );
  }

  const toggleExpand = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const fmtAge = (ts: number) => {
    const d = Math.floor((renderedAt - ts) / 86400000);
    if (d === 0) return 'today';
    if (d === 1) return '1d ago';
    if (d < 30) return `${d}d ago`;
    return `${Math.floor(d / 30)}mo ago`;
  };

  return (
    <div>
      {results.map((r) => {
        const key = `${r.item.id}-${r.ruleIndex}`;
        const isFP = falsePositives.has(r.item.id);
        const isExp = expanded.has(key);
        const title = r.item.kind === 'post' ? r.item.title : r.item.postTitle;
        return (
          <div
            key={key}
            className={`px-3 py-2.5 t-divider ${isFP ? 'opacity-40' : ''}`}
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="flex items-start gap-2">
              <ActionBadge action={r.action} />
              <div className="flex-1 min-w-0">
                <button className="w-full text-left cursor-pointer" onClick={() => toggleExpand(key)}>
                  {r.item.kind === 'post' ? (
                    <p className="text-sm t-text truncate">{title}</p>
                  ) : (
                    <p className="text-sm t-text-2 truncate italic">
                      {r.item.body.slice(0, 100)}...
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-0.5 text-xs t-text-3">
                    <span>u/{r.item.author}</span>
                    <span>|</span>
                    <span>{fmtAge(r.item.createdAt)}</span>
                    <span>|</span>
                    <span style={{ color: r.item.kind === 'post' ? 'var(--action-filter)' : 'var(--action-report)' }}>
                      {r.item.kind}
                    </span>
                    {r.matchedConditions.length > 0 && (
                      <>
                        <span>|</span>
                        <span>{r.matchedConditions.length} cond{r.matchedConditions.length !== 1 ? 's' : ''}</span>
                      </>
                    )}
                  </div>
                </button>
                {isExp && (
                  <div className="mt-2 pl-2 space-y-1.5" style={{ borderLeft: '2px solid var(--border)' }}>
                    {r.matchedConditions.map((c, i) => (
                      <div key={i} className="text-xs">
                        <span className="font-mono" style={{ color: 'var(--action-filter)' }}>{c.condition}</span>
                        {c.matchedValue && (
                          <>
                            <span className="t-text-3"> matched </span>
                            <span className="font-mono" style={{ color: 'var(--accent)' }}>"{c.matchedValue}"</span>
                          </>
                        )}
                        {c.excerpt && (
                          <div className="mt-1 t-text-3 t-code truncate">...{c.excerpt}...</div>
                        )}
                      </div>
                    ))}
                    {r.actionReason && (
                      <div className="text-xs t-text-3 italic">Reason: {r.actionReason}</div>
                    )}
                    <div className="flex gap-3 pt-1">
                      <a
                        href={redditUrl(r.item.permalink)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs t-text-3 hover:underline"
                        style={{ textDecoration: 'none' }}
                        onClick={(e) => {
                          e.preventDefault();
                          navigateTo(redditUrl(r.item.permalink));
                        }}
                        onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                        onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                      >
                        <span>View on Reddit</span>
                        <ExternalLinkIcon className="h-3.5 w-3.5" />
                      </a>
                      {!isFP && (
                        <button
                          className="inline-flex items-center gap-1 text-xs t-text-3 cursor-pointer"
                          style={{ background: 'none', border: 'none', padding: 0 }}
                          onClick={() => onFP(r.item.id)}
                        >
                          <SlashCircleIcon className="h-3.5 w-3.5" />
                          <span>False positive</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -- Diff mode -------------------------------------------------------------

function DiffMode({
  proposedYaml,
  live,
  items,
  onChange,
  onReloadLive,
  onSaveDraft,
  onApplyLive,
  onRollbackLive,
  busyAction,
  statusMessage,
  errorMessage,
}: {
  proposedYaml: string;
  live: LiveRuleState | null;
  items: Item[];
  onChange: (y: string) => void;
  onReloadLive: () => void;
  onSaveDraft: () => void;
  onApplyLive: () => void;
  onRollbackLive: () => void;
  busyAction: 'load' | 'draft' | 'apply' | 'rollback' | null;
  statusMessage: string | null;
  errorMessage: string | null;
}) {
  const { theme } = useTheme();
  const currentYaml = live?.yaml ?? '# No live AutoMod config found yet.\n';
  let diffError: string | null = null;

  const diff = (() => {
    if (!items.length || !live?.yaml) return null;
    try {
      const cur = evaluateAll(parseRules(live.yaml).rules, items);
      const prop = evaluateAll(parseRules(proposedYaml).rules, items);
      const curIds = new Set(cur.results.map((r) => r.item.id));
      const propIds = new Set(prop.results.map((r) => r.item.id));
      return {
        onlyNew: prop.results.filter((r) => !curIds.has(r.item.id)).length,
        onlyOld: cur.results.filter((r) => !propIds.has(r.item.id)).length,
        both: prop.results.filter((r) => curIds.has(r.item.id)).length,
      };
    } catch {
      diffError = 'Diff preview unavailable for unsupported AutoMod syntax.';
      return null;
    }
  })();

  const editorOpts = {
    fontSize: 12,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on' as const,
    padding: { top: 8 },
  };

  const liveUpdatedAt = live?.revisionDate ? new Date(live.revisionDate).toLocaleString() : 'not available';
  const draftSavedAt = live?.draftUpdatedAt ? new Date(live.draftUpdatedAt).toLocaleString() : 'not saved';
  const liveRevision = live?.revisionId ? live.revisionId.slice(0, 8) : 'none';

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: live config */}
      <div className="flex flex-col w-2/5 overflow-hidden" style={{ borderRight: '1px solid var(--border)' }}>
        <div className="t-pane-header">
          Live AutoMod{' '}
          {live?.exists && <span style={{ color: 'var(--action-approve)' }}> | live</span>}
        </div>
        <div className="flex-1 overflow-hidden">
          <Editor
            height="100%"
            defaultLanguage="yaml"
            value={currentYaml}
            theme={theme.monacoTheme}
            options={{ ...editorOpts, readOnly: true }}
          />
        </div>
      </div>
      {/* Center: actions */}
      <div className="flex flex-col w-1/5 p-4 text-xs space-y-4 overflow-y-auto" style={{ borderRight: '1px solid var(--border)' }}>
        <div className="t-text-2 font-medium" style={{ fontFamily: 'var(--font-ui)' }}>Live Actions</div>
        <div className="space-y-1 t-text-3 text-[11px]">
          <div><span className="t-text-2">Status:</span> {live?.exists ? 'Live config found' : 'No live config yet'}</div>
          <div><span className="t-text-2">Revision:</span> {liveRevision}</div>
          <div><span className="t-text-2">Updated:</span> {liveUpdatedAt}</div>
          <div><span className="t-text-2">Draft:</span> {draftSavedAt}</div>
          <div><span className="t-text-2">Rollback:</span> {live?.rollbackAvailable ? 'ready' : 'not available'}</div>
        </div>
        <div className="space-y-2">
          <button className="t-btn w-full" onClick={onReloadLive} disabled={busyAction !== null}>
            {busyAction === 'load' ? 'Loading...' : 'Reload live'}
          </button>
          <button className="t-btn w-full" onClick={onSaveDraft} disabled={busyAction !== null}>
            {busyAction === 'draft' ? 'Saving...' : 'Save draft'}
          </button>
          <button className="t-btn-primary w-full" onClick={onApplyLive} disabled={busyAction !== null || !proposedYaml.trim()}>
            {busyAction === 'apply' ? 'Applying...' : 'Apply to AutoMod'}
          </button>
          <button className="t-btn-danger w-full" onClick={onRollbackLive} disabled={busyAction !== null || !live?.rollbackAvailable}>
            {busyAction === 'rollback' ? 'Rolling back...' : 'Rollback'}
          </button>
        </div>
        <p className="text-[11px] leading-5 t-text-3">
          Applies to <span className="font-mono t-text-2">config/automoderator</span> for this subreddit.
        </p>
        {statusMessage && <div className="t-alert-ok">{statusMessage}</div>}
        {errorMessage && <div className="t-alert-err">{errorMessage}</div>}
        <div className="pt-2 t-text-2 font-medium text-xs" style={{ fontFamily: 'var(--font-ui)' }}>Diff</div>
        {!items.length && <p className="t-text-3 text-xs">Load data first</p>}
        {diffError && <p className="text-xs" style={{ color: 'var(--action-remove)' }}>{diffError}</p>}
        {diff && (
          <>
            <div>
              <div className="text-lg font-mono" style={{ color: 'var(--action-approve)' }}>{diff.onlyNew}</div>
              <div className="t-text-3 text-xs">only new catches</div>
            </div>
            <div>
              <div className="text-lg font-mono" style={{ color: 'var(--action-remove)' }}>{diff.onlyOld}</div>
              <div className="t-text-3 text-xs">only old catches</div>
            </div>
            <div>
              <div className="text-lg font-mono t-text-2">{diff.both}</div>
              <div className="t-text-3 text-xs">both catch</div>
            </div>
          </>
        )}
      </div>
      {/* Right: proposed */}
      <div className="flex flex-col w-2/5 overflow-hidden">
        <div className="t-pane-header">Proposed Rules</div>
        <div className="flex-1 overflow-hidden">
          <Editor
            height="100%"
            defaultLanguage="yaml"
            value={proposedYaml}
            theme={theme.monacoTheme}
            onChange={(v) => onChange(v ?? '')}
            options={editorOpts}
          />
        </div>
      </div>
    </div>
  );
}

function RulesTab({
  live,
  busyAction,
  errorMessage,
  onReloadLive,
  onEditRule,
  onMakeDraftLive,
}: {
  live: LiveRuleState | null;
  busyAction: string | null;
  errorMessage: string | null;
  onReloadLive: () => void;
  onEditRule: (yaml: string) => void;
  onMakeDraftLive: () => void;
}) {
  const [mode, setMode] = useState<'live' | 'draft'>('live');
  let parsed: ReturnType<typeof parseRules> | null = null;
  let parseError: string | null = null;
  const selectedYaml = mode === 'live' ? live?.yaml : live?.draftYaml;
  const selectedExists = mode === 'live' ? Boolean(live?.exists) : Boolean(live?.draftYaml?.trim());

  if (selectedYaml?.trim()) {
    try {
      parsed = parseRules(selectedYaml);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold t-text" style={{ fontFamily: 'var(--font-ui)' }}>
            Rules
          </h2>
          <p className="text-xs t-text-3 mt-1">
            {parsed
              ? `${parsed.rules.length} ${mode} rule${parsed.rules.length === 1 ? '' : 's'} ${mode === 'live' ? 'in config/automoderator' : 'saved as draft'}.`
              : `${mode === 'live' ? 'Live AutoMod config' : 'Saved draft'} has not been loaded yet.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded" style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
            <button
              className={mode === 'live' ? 't-btn-primary' : 't-btn'}
              style={{ borderRadius: 0, border: 'none' }}
              onClick={() => setMode('live')}
            >
              Live
            </button>
            <button
              className={mode === 'draft' ? 't-btn-primary' : 't-btn'}
              style={{ borderRadius: 0, border: 'none' }}
              onClick={() => setMode('draft')}
            >
              Draft
            </button>
          </div>
          <button className="t-btn" onClick={onReloadLive} disabled={busyAction !== null}>
            {busyAction === 'load' ? 'Loading...' : 'Reload'}
          </button>
          {mode === 'draft' && selectedExists && (
            <button className="t-btn-primary" onClick={onMakeDraftLive} disabled={busyAction !== null}>
              {busyAction === 'apply' ? 'Applying...' : 'Make draft live'}
            </button>
          )}
        </div>
      </div>

      {errorMessage && <div className="t-alert-err">{errorMessage}</div>}
      {parseError && <div className="t-alert-err">{parseError}</div>}
      {live && !selectedExists && (
        <div className="t-alert-info">
          {mode === 'live'
            ? 'No live AutoMod config exists for this subreddit yet.'
            : 'No saved draft exists yet. Save YAML from the editor to create one.'}
        </div>
      )}
      {parsed?.warnings.length ? (
        <RuleWarningsPanel warnings={parsed.warnings} unsupportedFields={parsed.unsupportedFields} />
      ) : null}

      {parsed?.rules.map((rule, index) => {
        const conditions = ruleConditionSummaries(rule);
        return (
          <div key={`${index}-${rule.rawYaml?.slice(0, 24)}`} className="t-card p-4 space-y-3">
            <div className="flex justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">Rule {index + 1}</span>
                  <span className={`t-badge ${mode === 'live' ? 't-badge-success' : 't-badge-warn'}`}>
                    {mode}
                  </span>
                  <span className="t-badge t-badge-neutral">{rule.type}</span>
                  <ActionBadge action={rule.action ?? null} />
                </div>
                <p className="text-xs t-text-3 mt-1 truncate">
                  {rule.actionReason || 'No action reason'}
                </p>
              </div>
              <button className="t-btn shrink-0" onClick={() => onEditRule(rule.rawYaml ?? '')}>
                Edit in YAML
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {conditions.length ? conditions.slice(0, 8).map((condition) => (
                <span key={condition} className="t-badge t-badge-neutral">{condition}</span>
              )) : <span className="text-xs t-text-3">No supported conditions detected.</span>}
            </div>
            <pre className="t-code max-h-52 overflow-auto">{rule.rawYaml}</pre>
          </div>
        );
      })}
    </div>
  );
}

// -- Suggestions tab -------------------------------------------------------

function SuggestionsTab({
  suggestions,
  onApply,
  onDismiss,
  hasApiKey,
  seedError,
  subredditName,
  onDevRemoveTrainingItems,
  devRemovingTrainingItems,
}: {
  suggestions: RuleSuggestion[];
  onApply: (y: string) => void;
  onDismiss: (id: string) => void;
  hasApiKey: boolean;
  seedError: string | null;
  subredditName: string;
  onDevRemoveTrainingItems: () => void;
  devRemovingTrainingItems: boolean;
}) {
  const showDevRemove = subredditName.toLowerCase() === 'automod_sandbox_dev';

  if (!suggestions.length) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 t-text-3 gap-3 p-8">
        <SparkIcon className="h-8 w-8" />
        <p className="text-sm text-center">No suggestions yet.</p>
        <p className="text-xs t-text-3 max-w-xs text-center" style={{ color: 'var(--text-3)' }}>
          AutoMod Studio scores candidate rules against recent history and known false positives.
          Once you have 5+ removals, it can rank suggestions even without an LLM key.
          {!hasApiKey && ' Add llmApiKey in the app\'s Devvit subreddit settings for extra LLM-generated candidates.'}
        </p>
        {showDevRemove && (
          <button
            className="t-btn-danger"
            onClick={onDevRemoveTrainingItems}
            disabled={devRemovingTrainingItems}
          >
            {devRemovingTrainingItems ? 'Removing...' : 'Remove dev training items'}
          </button>
        )}
        {seedError && <div className="t-alert-err max-w-sm text-center">{seedError}</div>}
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {seedError && <div className="t-alert-err">{seedError}</div>}
      {suggestions.map((s) => (
        <div key={s.id} className="t-card p-4 space-y-3">
          <div className="flex justify-between gap-2">
            <div>
              <span className="text-sm font-medium" style={{ color: 'var(--accent)' }}>
                {s.matchCount}/{s.totalRemovals} removals
              </span>
              <span className="text-xs t-text-3 ml-2">would be auto-caught</span>
              <p className="text-xs t-text-3 mt-0.5">{s.reasoning}</p>
              <div className="flex flex-wrap gap-2 mt-2">
                <span className="t-badge t-badge-neutral">
                  {s.source === 'heuristic' ? 'Heuristic' : s.source === 'template' ? 'Template' : s.source.charAt(0).toUpperCase() + s.source.slice(1)} candidate
                </span>
                <span className={`t-badge ${s.confidence === 'high' ? 't-badge-success' : s.confidence === 'medium' ? 't-badge-warn' : 't-badge-err'}`}>
                  {s.confidence} confidence
                </span>
                <span className="t-badge t-badge-neutral">precision {Math.round(s.estimatedPrecision * 100)}%</span>
                <span className="t-badge t-badge-neutral">recall {Math.round(s.estimatedRecall * 100)}%</span>
                <span className="t-badge t-badge-neutral">{s.historyMatchCount} history matches</span>
                <span className="t-badge t-badge-neutral">{s.nonRemovalMatchCount} non-removal</span>
                <span className={`t-badge ${s.falsePositiveMatchCount > 0 ? 't-badge-err' : 't-badge-success'}`}>
                  {s.falsePositiveMatchCount} false positives
                </span>
              </div>
              {s.warningMessages.length > 0 && (
                <div className="mt-2 space-y-1 text-[11px]" style={{ color: 'var(--action-filter)' }}>
                  {s.warningMessages.map((w) => <div key={w}>Warning: {w}</div>)}
                </div>
              )}
            </div>
            <button
              className="t-text-3 cursor-pointer shrink-0"
              style={{ background: 'none', border: 'none', padding: 0 }}
              onClick={() => onDismiss(s.id)}
              aria-label="Dismiss"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <pre className="t-code">{s.yaml}</pre>
          {s.exampleItems.map((item, i) => (
            <div key={i} className="text-xs t-text-3 truncate">
              u/{item.author} | {item.title ? `"${item.title.slice(0, 50)}"` : `"${item.body.slice(0, 70)}..."`}
            </div>
          ))}
          <div className="flex gap-2">
            <button className="t-btn-primary" onClick={() => onApply(s.yaml)}>Use in editor</button>
            <button className="t-btn" onClick={() => onDismiss(s.id)}>Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// -- Plain English tab -----------------------------------------------------

function PlainEnglishTab({ hasApiKey, onApply }: { hasApiKey: boolean; onApply: (y: string) => void }) {
  const [desc, setDesc] = useState('');
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(false);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ yaml: string; reasoning: string; source: string } | null>(null);

  const examples = [
    'Remove posts from accounts younger than 7 days that link to twitter.com',
    'Filter comments with fewer than 5 karma containing "buy" or "discount"',
    'Report posts with more than 3 reports that were edited',
  ];

  async function handleSubmit() {
    if (!desc.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc }),
      });
      const data = await readApiJson<TranslateResponse>(resp);
      if (data.status === 'ok') {
        setResult({ yaml: data.yaml, reasoning: data.reasoning, source: data.source });
      } else {
        setError(data.message);
      }
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }

  async function handleRevise() {
    if (!desc.trim() || !feedback.trim() || !result) return;
    setRevising(true);
    setError(null);
    try {
      const resp = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: desc,
          currentYaml: result.yaml,
          feedback,
        }),
      });
      const data = await readApiJson<TranslateResponse>(resp);
      if (data.status === 'ok') {
        setResult({ yaml: data.yaml, reasoning: data.reasoning, source: data.source });
        setFeedback('');
      } else {
        setError(data.message);
      }
    } catch (e) {
      setError(String(e));
    }
    setRevising(false);
  }

  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-4 space-y-4">
      <div className={hasApiKey ? 't-alert-info' : 't-alert-ok'}>
        {hasApiKey
          ? 'LLM mode is enabled. Write free-form descriptions - the app still lints the result against the supported subset.'
          : 'Local template mode. To enable LLM mode, add llmApiKey in this app\'s Devvit subreddit settings, then reopen AutoMod Studio.'}
      </div>
      <div>
        <label className="block text-xs t-text-3 mb-2" style={{ fontFamily: 'var(--font-ui)' }}>
          Describe the rule in plain English
        </label>
        <textarea
          className="t-textarea"
          rows={4}
          placeholder="Remove posts from accounts younger than 7 days that include a Twitter link..."
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void handleSubmit(); }}
        />
        <div className="flex justify-between items-center mt-2">
          <span className="text-xs t-text-3" style={{ fontFamily: 'var(--font-ui)' }}>
            <kbd style={{ background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.125rem 0.375rem', fontFamily: 'var(--font-body)', fontSize: '0.75rem' }}>
              Ctrl/Command Enter
            </kbd>{' '}
            to translate
          </span>
          <button className="t-btn-primary" onClick={() => void handleSubmit()} disabled={loading || !desc.trim()}>
            {loading ? 'Translating...' : 'Translate to YAML'}
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xs t-text-3" style={{ fontFamily: 'var(--font-ui)' }}>Examples:</p>
        {examples.map((ex) => (
          <button
            key={ex}
            className="block w-full text-left text-xs t-text-3 rounded px-2 py-1.5 cursor-pointer"
            style={{ background: 'none', border: 'none', fontFamily: 'var(--font-ui)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-3)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
            onClick={() => setDesc(ex)}
          >
            matched {ex}
          </button>
        ))}
      </div>
      {error && <div className="t-alert-err">{error}</div>}
      {result && (
        <div className="t-card p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-xs t-text-2 font-medium" style={{ fontFamily: 'var(--font-ui)' }}>
              Generated YAML | {result.source === 'template' ? 'local template' : result.source}
            </span>
            <button className="t-btn-primary" onClick={() => onApply(result.yaml)}>Use in editor</button>
          </div>
          <pre className="t-code">{result.yaml}</pre>
          <p className="text-xs t-text-3 italic">{result.reasoning}</p>
          <div className="space-y-2">
            <label className="block text-xs t-text-3" style={{ fontFamily: 'var(--font-ui)' }}>
              Ask AI to revise this YAML
            </label>
            <textarea
              className="t-textarea"
              rows={3}
              placeholder="Example: make it filter instead of remove, exclude moderators, and only match comments"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <button
              className="t-btn"
              onClick={() => void handleRevise()}
              disabled={revising || !hasApiKey || !feedback.trim()}
              title={hasApiKey ? 'Send this feedback and the generated YAML back to the LLM' : 'Add an LLM API key in Devvit settings to revise generated YAML'}
            >
              {revising ? 'Revising...' : 'Revise with feedback'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// -- Onboarding panel ------------------------------------------------------

function OnboardingPanel({ hasApiKey, subredditName }: { hasApiKey: boolean; subredditName: string }) {
  return (
    <div className="t-card w-full max-w-2xl p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold t-text" style={{ fontFamily: 'var(--font-ui)' }}>
          Quick start for r/{subredditName || '...'}
        </h2>
        <p className="text-xs t-text-3 mt-1">
          Load recent history, draft a rule, check the matches, then apply only after the diff looks safe.
        </p>
      </div>
      <div className="grid gap-2 md:grid-cols-2 text-xs">
        {[
          '1. Load recent posts and comments from this subreddit.',
          '2. Start in YAML or use Describe in English for a starter rule.',
          '3. Mark false positives so future suggestions learn what not to catch.',
          '4. Use Diff Mode before touching live AutoMod.',
        ].map((step) => (
          <div key={step} className="t-card px-3 py-2 t-text-2">{step}</div>
        ))}
      </div>
      <div className="text-[11px] leading-5 t-text-3">
        {hasApiKey
          ? 'LLM mode is available for freer translations and extra suggestion candidates.'
          : 'No key needed: local template mode already covers keywords, domains, age, karma, edited, and reports.'}
      </div>
    </div>
  );
}

// -- Help modal ------------------------------------------------------------

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="t-card w-full max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center">
          <h2 className="text-sm font-semibold t-text" style={{ fontFamily: 'var(--font-ui)' }}>Keyboard Shortcuts</h2>
          <button className="t-text-3 cursor-pointer" style={{ background: 'none', border: 'none', padding: 0 }} onClick={onClose} aria-label="Close">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {[['?','Toggle help'],['Ctrl/Command R','Refresh data'],['Ctrl/Command Enter','Submit plain-English'],['1-5','Switch tabs']].map(([k, d]) => (
              <tr key={k} className="t-divider">
                <td className="py-2 w-20">
                  <kbd style={{ background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.125rem 0.375rem', fontFamily: 'var(--font-body)', fontSize: '0.75rem' }}>
                    {k}
                  </kbd>
                </td>
                <td className="py-2 t-text-3">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// -- Progress bar ----------------------------------------------------------

function ProgressBar({ fetched, phase }: { fetched: number; phase: string }) {
  const pct = Math.min(100, (fetched / 1000) * 100);
  return (
    <div className="shrink-0 px-4 py-2" style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}>
      <div className="flex justify-between mb-1">
        <span className="text-xs t-text-2">{phase}</span>
        <span className="text-xs t-text-3">{fetched.toLocaleString()} items</span>
      </div>
      <div className="t-progress-track">
        <div className="t-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// -- Main App --------------------------------------------------------------

type Tab = 'editor' | 'rules' | 'plain-english' | 'diff' | 'suggestions';

type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (confirmed: boolean) => void;
};

function ConfirmDialog({
  dialog,
  onResolve,
}: {
  dialog: ConfirmDialogState;
  onResolve: (confirmed: boolean) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.62)' }}
      onClick={() => onResolve(false)}
    >
      <div className="t-card w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start gap-3">
          <div>
            <h2 className="text-sm font-semibold t-text" style={{ fontFamily: 'var(--font-ui)' }}>
              {dialog.title}
            </h2>
            <p className="text-xs t-text-3 mt-2 leading-5">{dialog.message}</p>
          </div>
          <button
            className="t-text-3 cursor-pointer shrink-0"
            style={{ background: 'none', border: 'none', padding: 0 }}
            onClick={() => onResolve(false)}
            aria-label="Cancel"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex justify-end gap-2">
          <button className="t-btn" onClick={() => onResolve(false)}>Cancel</button>
          <button
            className={dialog.danger ? 't-btn-danger' : 't-btn-primary'}
            onClick={() => onResolve(true)}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [subredditName, setSubredditName] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [cachedCount, setCachedCount] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [results, setResults] = useState<MatchResult[]>([]);
  const [evalMs, setEvalMs] = useState<number | null>(null);
  const [totalItems, setTotalItems] = useState(0);
  const [tab, setTab] = useState<Tab>('editor');
  const [yaml, setYaml] = useState(DEFAULT_YAML);
  const [loading, setLoading] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ fetched: number; phase: string } | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<LiveRuleState | null>(null);
  const [liveBusyAction, setLiveBusyAction] = useState<'load' | 'draft' | 'apply' | 'rollback' | null>(null);
  const [liveStatusMessage, setLiveStatusMessage] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [devRemovingTrainingItems, setDevRemovingTrainingItems] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [falsePositives, setFalsePositives] = useState(new Set<string>());
  const [parseWarnings, setParseWarnings] = useState<ParseWarning[]>([]);
  const [unsupportedFields, setUnsupportedFields] = useState<string[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  // Theme state
  const theme = THEMES.find((t) => t.id === 'reddit') ?? THEMES[0]!;

  const setThemeId = useCallback((_id: ThemeId) => undefined, []);

  // Apply theme on mount and when it changes
  useEffect(() => { applyTheme(theme); }, [theme]);

  const debouncedYaml = useDebounce(yaml, 400);
  const initialized = useRef(false);
  const restoredDraft = useRef(false);

  const requestConfirmation = useCallback(
    (input: Omit<ConfirmDialogState, 'resolve'>): Promise<boolean> =>
      new Promise((resolve) => {
        setConfirmDialog({ ...input, resolve });
      }),
    []
  );

  const resolveConfirmation = useCallback((confirmed: boolean) => {
    setConfirmDialog((dialog) => {
      dialog?.resolve(confirmed);
      return null;
    });
  }, []);

  // Init
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void (async () => {
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 8000);
        const resp = await fetch('/api/init', { signal: controller.signal });
        let data: InitResponse;
        try {
          data = await readApiJson<InitResponse>(resp);
        } catch (e) {
          setEvalError(`Init failed: ${String(e)}`);
          return;
        }
        setSubredditName(data.subredditName);
        setHasApiKey(data.hasLlmKey);
        setCachedCount(data.cachedItemCount);
        setFalsePositives(new Set(data.falsePositiveIds));
        void loadLiveRules({ silent: true, restoreDraft: true });
        if (data.cachedItemCount > 0) await handleRefresh(true);
      } catch (e) {
        setEvalError(`Init failed: ${String(e)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-evaluate
  useEffect(() => {
    if (!debouncedYaml || !items.length) return;
    setEvaluating(true);
    setEvalError(null);
    try {
      const parsed = parseRules(debouncedYaml);
      setParseWarnings(parsed.warnings);
      setUnsupportedFields(parsed.unsupportedFields);
      if (parsed.rules.length === 0) {
        setEvalError('No rules found in YAML.');
        setResults([]);
        setEvalMs(null);
        setTotalItems(items.length);
        return;
      }
      const summary = evaluateAll(parsed.rules, items);
      setResults(summary.results);
      setEvalMs(summary.evaluationMs);
      setTotalItems(summary.totalItems);
    } catch (e) {
      setEvalError(e instanceof Error ? e.message : String(e));
      setParseWarnings([]);
      setUnsupportedFields([]);
      setResults([]);
      setEvalMs(null);
      setTotalItems(items.length);
    } finally {
      setEvaluating(false);
    }
  }, [debouncedYaml, items]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === '?') { setShowHelp((h) => !h); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') { e.preventDefault(); void handleRefresh(false); return; }
    if (!e.metaKey && !e.ctrlKey && ['1','2','3','4','5'].includes(e.key)) {
      const tabs: Tab[] = ['editor','rules','plain-english','diff','suggestions'];
      setTab(tabs[parseInt(e.key) - 1]!);
    }
  }, []);
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  async function handleRefresh(useCache = true) {
    setLoading(true);
    setFetchProgress(null);
    setEvalError(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let resp: Response;
      try {
        resp = await fetch('/api/fetch-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: !useCache }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      let data: FetchHistoryResponse;
      try {
        data = await readApiJson<FetchHistoryResponse>(resp);
      } catch (e) {
        setEvalError(String(e));
        return;
      }
      if (data.status === 'ok') {
        setItems(data.items);
        setCachedCount(data.totalFetched);
        setTotalItems(data.totalFetched);
        await loadLiveRules({ silent: true });
      } else if (data.status === 'fetching') {
        setEvalError(data.message);
      } else {
        setEvalError(`fetch-history error: ${data.message}`);
      }
    } catch (e) {
      setEvalError(`Network error: ${String(e)}`);
    }
    setLoading(false);
  }

  function handleEditRuleFromRules(ruleYaml: string) {
    setYaml(ruleYaml);
    setTab('editor');
    if (!items.length && !loading) {
      void handleRefresh(true);
    }
  }

  async function loadLiveRules(options?: { silent?: boolean; restoreDraft?: boolean }) {
    const silent = options?.silent ?? false;
    const restoreDraft = options?.restoreDraft ?? false;
    setLiveBusyAction('load');
    if (!silent) { setLiveError(null); setLiveStatusMessage(null); }
    try {
      const resp = await fetch('/api/live-rules');
      const data = await readApiJson<LiveRulesResponse>(resp);
      if (data.status !== 'ok') { if (!silent) setLiveError(data.message); return; }
      setLiveState(data.live);
      if (restoreDraft && !restoredDraft.current && data.live.draftYaml && (yaml === DEFAULT_YAML || !yaml.trim())) {
        restoredDraft.current = true;
        setYaml(data.live.draftYaml);
        setLiveStatusMessage('Restored the saved draft for this subreddit.');
      } else if (!silent) {
        setLiveStatusMessage(data.live.exists ? 'Loaded live AutoMod from the subreddit wiki.' : 'No live AutoMod config exists yet. Applying will create it.');
      }
    } catch (e) {
      if (!silent) setLiveError(`Failed to load live AutoMod: ${String(e)}`);
    } finally {
      setLiveBusyAction(null);
    }
  }

  async function handleSaveDraft() {
    setLiveBusyAction('draft'); setLiveError(null); setLiveStatusMessage(null);
    try {
      const resp = await fetch('/api/live-rules/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml }) });
      const data = await readApiJson<SaveDraftResponse>(resp);
      if (data.status !== 'ok') { setLiveError(data.message); return; }
      restoredDraft.current = true;
      setLiveState(data.live);
      setLiveStatusMessage(data.message);
    } catch (e) {
      setLiveError(`Failed to save draft: ${String(e)}`);
    } finally {
      setLiveBusyAction(null);
    }
  }

  async function handleApplyLiveRules() {
    if (!yaml.trim()) { setLiveError('Cannot apply empty AutoMod YAML.'); setLiveStatusMessage(null); return; }
    const confirmed = await requestConfirmation({
      title: 'Apply Live AutoMod',
      message: `Apply the current editor YAML to live AutoMod in r/${subredditName}? This changes config/automoderator for the subreddit.`,
      confirmLabel: 'Apply',
      danger: true,
    });
    if (!confirmed) return;
    setLiveBusyAction('apply'); setLiveError(null); setLiveStatusMessage(null);
    try {
      const resp = await fetch('/api/live-rules/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml, mode: 'append' }) });
      const data = await readApiJson<ApplyLiveRulesResponse>(resp);
      if (data.status !== 'ok') { setLiveError(data.message); return; }
      restoredDraft.current = true;
      setLiveState(data.live);
      setLiveStatusMessage(data.message);
    } catch (e) {
      setLiveError(`Failed to apply live AutoMod: ${String(e)}`);
    } finally {
      setLiveBusyAction(null);
    }
  }

  async function handleApplyDraftLive() {
    const draftYaml = liveState?.draftYaml?.trim();
    if (!draftYaml) {
      setLiveError('No saved draft is available to apply.');
      setLiveStatusMessage(null);
      return;
    }
    const confirmed = await requestConfirmation({
      title: 'Make Draft Live',
      message: `Add the saved draft to live AutoMod in r/${subredditName}? Existing live rules will be kept.`,
      confirmLabel: 'Apply draft',
      danger: true,
    });
    if (!confirmed) return;
    setLiveBusyAction('apply'); setLiveError(null); setLiveStatusMessage(null);
    try {
      const resp = await fetch('/api/live-rules/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml: draftYaml, mode: 'append' }) });
      const data = await readApiJson<ApplyLiveRulesResponse>(resp);
      if (data.status !== 'ok') { setLiveError(data.message); return; }
      restoredDraft.current = true;
      setYaml(draftYaml);
      setLiveState(data.live);
      setLiveStatusMessage(data.message);
    } catch (e) {
      setLiveError(`Failed to apply saved draft: ${String(e)}`);
    } finally {
      setLiveBusyAction(null);
    }
  }

  async function handleRollbackLiveRules() {
    const confirmed = await requestConfirmation({
      title: 'Rollback Live AutoMod',
      message: `Roll live AutoMod back to the previous saved revision in r/${subredditName}?`,
      confirmLabel: 'Rollback',
      danger: true,
    });
    if (!confirmed) return;
    setLiveBusyAction('rollback'); setLiveError(null); setLiveStatusMessage(null);
    try {
      const resp = await fetch('/api/live-rules/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await readApiJson<RollbackLiveRulesResponse>(resp);
      if (data.status !== 'ok') { setLiveError(data.message); return; }
      setLiveState(data.live);
      setLiveStatusMessage(data.message);
    } catch (e) {
      setLiveError(`Failed to roll back live AutoMod: ${String(e)}`);
    } finally {
      setLiveBusyAction(null);
    }
  }

  async function handleTabChange(t: Tab) {
    setTab(t);
    if ((t === 'diff' || t === 'rules') && !liveState) await loadLiveRules();
    if (t === 'suggestions' && !suggestions.length) {
      try {
        setSuggestionsError(null);
        const resp = await fetch('/api/suggestions');
        const data = await readApiJson<SuggestionsResponse>(resp);
        if (data.status === 'error') {
          setSuggestionsError(data.message);
          return;
        }
        setSuggestions(data.suggestions);
      } catch (e) {
        setSuggestionsError(`Failed to load suggestions: ${String(e)}`);
      }
    }
  }

  async function handleDevRemoveTrainingItems() {
    const confirmed = await requestConfirmation({
      title: 'Remove Dev Training Items',
      message: `Remove up to 5 real recent posts or comments in r/${subredditName} that look like spam, then record them for Suggestions?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    setDevRemovingTrainingItems(true);
    setSuggestionsError(null);
    try {
      const resp = await fetch('/api/dev/remove-training-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await readApiJson<DevRemoveTrainingItemsResponse>(resp);
      if (data.status !== 'ok') {
        setSuggestionsError(data.message);
        return;
      }
      setSuggestionsError(data.message);
      const suggestionsResp = await fetch('/api/suggestions');
      const suggestionsData = await readApiJson<SuggestionsResponse>(suggestionsResp);
      if (suggestionsData.status === 'ok') {
        setSuggestions(suggestionsData.suggestions);
      }
    } catch (e) {
      setSuggestionsError(`Failed to remove dev training items: ${String(e)}`);
    } finally {
      setDevRemovingTrainingItems(false);
    }
  }

  async function handleFP(itemId: string) {
    setFalsePositives((prev) => new Set([...prev, itemId]));
    await fetch('/api/false-positive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId }) });
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'editor', label: 'YAML Editor' },
    { id: 'rules', label: 'Rules' },
    { id: 'plain-english', label: 'Describe in English' },
    { id: 'diff', label: 'Diff Mode' },
    { id: 'suggestions', label: suggestions.length ? `Suggestions (${suggestions.length})` : 'Suggestions' },
  ];

  const dataLoaded = items.length > 0;
  const showWorkspace = dataLoaded || tab === 'rules';
  const headerItemLabel = dataLoaded
    ? `${items.length.toLocaleString()} items`
    : cachedCount > 0
      ? `${cachedCount.toLocaleString()} cached`
      : 'no data';

  return (
    <ThemeContext.Provider value={{ theme, setThemeId }}>
      <div className={`t-root ${theme.rootClass}`}>
        {/* Header */}
        <header className="t-header">
          <div className="flex items-center gap-3">
            <span className="t-logo inline-flex items-center gap-2">
              <BoltIcon className="h-4 w-4" />
              AutoMod Studio
            </span>
            {subredditName && (
              <span className="text-sm t-text-3">r/{subredditName}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs t-text-3">{headerItemLabel}</span>
            <button className="t-btn" onClick={() => void handleRefresh(false)} disabled={loading}>
              {loading ? 'Loading...' : 'Refresh data'}
            </button>
            <button className="t-btn" onClick={() => setShowHelp(true)}>?</button>
          </div>
        </header>

        {/* Progress bar */}
        {loading && fetchProgress && (
          <ProgressBar fetched={fetchProgress.fetched} phase={fetchProgress.phase} />
        )}

        {/* Empty state */}
        {!loading && !dataLoaded && (
          <div className="flex flex-col items-center justify-center flex-1 gap-4 t-text-3">
            <TrayIcon className="h-10 w-10" />
            <p className="text-sm">No subreddit data loaded yet.</p>
            <OnboardingPanel hasApiKey={hasApiKey} subredditName={subredditName} />
            <button className="t-btn-primary" style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }} onClick={() => void handleRefresh(false)}>
              Load history for r/{subredditName || '...'}
            </button>
            <button className="t-btn" style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }} onClick={() => void handleTabChange('rules')}>
              View established rules
            </button>
            {evalError && (
              <div className="t-alert-err max-w-sm font-mono whitespace-pre-wrap">{evalError}</div>
            )}
            {!hasApiKey && (
              <p className="text-xs t-text-3 max-w-xs text-center">
                LLM key is optional. To add one, open this app's Devvit subreddit settings and set llmApiKey.
              </p>
            )}
          </div>
        )}

        {/* Main content */}
        {showWorkspace && (
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Tab bar */}
            <div className="t-tab-bar">
              {TABS.map((t, i) => (
                <button
                  key={t.id}
                  className={`t-tab ${tab === t.id ? 'active' : ''}`}
                  onClick={() => void handleTabChange(t.id)}
                  title={`${t.label} (${i + 1})`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex flex-1 overflow-hidden">
              {tab === 'editor' && (
                <>
                  {/* Left: YAML editor */}
                  <div className="flex flex-col w-1/2 overflow-hidden" style={{ borderRight: '1px solid var(--border)' }}>
                    <div className="t-pane-header flex justify-between items-center gap-3">
                      <span>AutoMod YAML</span>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="t-text-3 truncate">
                          {evaluating ? (
                            <span className="t-pulse">evaluating...</span>
                          ) : evalMs !== null ? (
                            `${results.length.toLocaleString()} matches | ${totalItems.toLocaleString()} items | ${evalMs}ms`
                          ) : null}
                        </span>
                        <button
                          className="t-btn"
                          onClick={() => void handleSaveDraft()}
                          disabled={liveBusyAction !== null}
                          title="Save this YAML as a draft for this subreddit"
                        >
                          {liveBusyAction === 'draft' ? 'Saving...' : 'Save draft'}
                        </button>
                        <button
                          className="t-btn-primary"
                          onClick={() => void handleApplyLiveRules()}
                          disabled={liveBusyAction !== null || !yaml.trim()}
                          title="Apply this YAML to live AutoMod"
                        >
                          {liveBusyAction === 'apply' ? 'Applying...' : 'Apply live'}
                        </button>
                      </div>
                    </div>
                    {liveStatusMessage && <div className="t-alert-ok mx-0 rounded-none border-x-0 border-t-0">{liveStatusMessage}</div>}
                    {liveError && <div className="t-alert-err mx-0 rounded-none border-x-0 border-t-0">{liveError}</div>}
                    {evalError && <div className="t-alert-err mx-0 rounded-none border-x-0 border-t-0">{evalError}</div>}
                    <RuleWarningsPanel warnings={parseWarnings} unsupportedFields={unsupportedFields} />
                    <div className="flex-1 overflow-hidden">
                      <Editor
                        height="100%"
                        defaultLanguage="yaml"
                        value={yaml}
                        theme={theme.monacoTheme}
                        onChange={(v) => setYaml(v ?? '')}
                        options={{
                          fontSize: 13,
                          minimap: { enabled: false },
                          scrollBeyondLastLine: false,
                          wordWrap: 'on',
                          automaticLayout: true,
                          tabSize: 2,
                          padding: { top: 12 },
                          fontFamily: 'SF Mono, Cascadia Code, Fira Code, Consolas, monospace',
                        }}
                      />
                    </div>
                  </div>
                  {/* Right: results */}
                  <div className="flex flex-col w-1/2 overflow-hidden">
                    <div className="t-pane-header">Matched Items</div>
                    <div className="flex-1 overflow-y-auto">
                      {!items.length ? (
                        <div className="p-4 text-sm t-text-2">
                          {loading ? 'Loading subreddit history so this YAML can be previewed...' : 'Load subreddit history to preview matched items for this YAML.'}
                        </div>
                      ) : (
                        <ResultsPanel results={results} falsePositives={falsePositives} onFP={(id) => void handleFP(id)} />
                      )}
                    </div>
                  </div>
                </>
              )}
              {tab === 'plain-english' && (
                <PlainEnglishTab
                  hasApiKey={hasApiKey}
                  onApply={(y) => { setYaml(y); setTab('editor'); }}
                />
              )}
              {tab === 'rules' && (
                <RulesTab
                  live={liveState}
                  busyAction={liveBusyAction}
                  errorMessage={liveError}
                  onReloadLive={() => void loadLiveRules()}
                  onEditRule={handleEditRuleFromRules}
                  onMakeDraftLive={() => void handleApplyDraftLive()}
                />
              )}
              {tab === 'diff' && (
                <DiffMode
                  proposedYaml={yaml}
                  live={liveState}
                  items={items}
                  onChange={setYaml}
                  onReloadLive={() => void loadLiveRules()}
                  onSaveDraft={() => void handleSaveDraft()}
                  onApplyLive={() => void handleApplyLiveRules()}
                  onRollbackLive={() => void handleRollbackLiveRules()}
                  busyAction={liveBusyAction}
                  statusMessage={liveStatusMessage}
                  errorMessage={liveError}
                />
              )}
              {tab === 'suggestions' && (
                <SuggestionsTab
                  suggestions={suggestions}
                  onApply={(y) => { setYaml(y); setTab('editor'); }}
                  onDismiss={(id) => setSuggestions((s) => s.filter((x) => x.id !== id))}
                  hasApiKey={hasApiKey}
                  seedError={suggestionsError}
                  subredditName={subredditName}
                  onDevRemoveTrainingItems={() => void handleDevRemoveTrainingItems()}
                  devRemovingTrainingItems={devRemovingTrainingItems}
                />
              )}
            </div>
          </div>
        )}

        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        {confirmDialog && <ConfirmDialog dialog={confirmDialog} onResolve={resolveConfirmation} />}
      </div>
    </ThemeContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

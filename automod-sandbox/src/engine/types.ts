// Engine types — no Devvit imports allowed in this directory.
// These types model AutoMod YAML rules and the items they are evaluated against.

export type ItemType = 'submission' | 'comment' | 'any';

export type TextModifier =
  | 'includes'
  | 'includes-word'
  | 'starts-with'
  | 'ends-with'
  | 'full-exact'
  | 'regex';

export type ComparisonOperator = '<' | '>' | '<=' | '>=' | '=';

export interface ComparisonValue {
  operator: ComparisonOperator;
  value: number;
  unit?: 'days' | 'months' | 'years' | 'hours'; // for account_age
}

export interface TextCondition {
  modifier: TextModifier;
  values: string[];
  caseSensitive: boolean;
  excludes?: TextCondition[];   // each must NOT match for the overall condition to pass
}

export interface ParsedTextField {
  condition: TextCondition;
  unsupportedKeys: string[];
  hasExplicitModifier: boolean;
}

export interface AuthorCondition {
  commentKarma?: ComparisonValue;
  postKarma?: ComparisonValue;
  accountAge?: ComparisonValue;
  name?: TextCondition;
  flairText?: TextCondition;
  isGold?: boolean;
  isMod?: boolean;
}

export interface ParsedRule {
  // Content conditions
  type: ItemType;
  title?: TextCondition;
  body?: TextCondition;
  titleAndBody?: TextCondition; // title+body combined check
  domain?: TextCondition;

  // Author conditions
  author?: AuthorCondition;

  // Meta conditions
  isEdited?: boolean;
  flairText?: TextCondition;
  flairCssClass?: TextCondition;
  reports?: ComparisonValue;

  // Action to simulate
  action?: Action;
  actionReason?: string;

  // For multi-rule files, the original YAML for reference
  rawYaml?: string;
}

export interface ParseWarning {
  ruleIndex: number;
  code:
    | 'empty-rule'
    | 'empty-text-condition'
    | 'invalid-regex'
    | 'missing-exception'
    | 'overly-broad-rule'
    | 'shadowed-rule'
    | 'unknown-action'
    | 'unknown-type'
    | 'unsupported-author-field'
    | 'unsupported-field'
    | 'unsupported-text-modifier';
  message: string;
  field?: string;
}

export interface ParseResult {
  rules: ParsedRule[];
  warnings: ParseWarning[];
  unsupportedFields: string[];
}

export type Action = 'remove' | 'filter' | 'report' | 'approve';

export interface Post {
  kind: 'post';
  id: string;
  title: string;
  body: string; // selftext
  url: string;
  domain: string;
  author: string;
  authorId: string;
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number; // days since account creation
  authorIsMod: boolean;
  authorIsGold: boolean;
  authorFlairText: string;
  authorFlairCssClass: string;
  createdAt: number; // unix timestamp ms
  edited: boolean;
  flairText: string;
  flairCssClass: string;
  reports: number;
  permalink: string;
  thumbnail?: string;
}

export interface Comment {
  kind: 'comment';
  id: string;
  body: string;
  author: string;
  authorId: string;
  authorCommentKarma: number;
  authorPostKarma: number;
  authorAccountAge: number; // days
  authorIsMod: boolean;
  authorIsGold: boolean;
  authorFlairText: string;
  authorFlairCssClass: string;
  createdAt: number; // unix timestamp ms
  edited: boolean;
  flairText: string;
  flairCssClass: string;
  reports: number;
  permalink: string;
  postTitle: string; // parent post title, for title+body checks on comments
  postId: string;
}

export type Item = Post | Comment;

export interface MatchedCondition {
  condition: string; // human-readable condition name e.g. "title includes-word"
  matchedValue?: string; // the specific value that matched e.g. "spam"
  excerpt?: string; // relevant excerpt from the item text
}

export interface MatchResult {
  matched: boolean;
  matchedConditions: MatchedCondition[];
  action: Action | null;
  actionReason?: string;
  item: Item;
  ruleIndex: number; // which rule in a multi-rule file matched
}

export interface EvaluationSummary {
  totalItems: number;
  matchedItems: number;
  results: MatchResult[];
  evaluationMs: number;
}

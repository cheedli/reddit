import type { ApiAction } from '../../shared/api.js';

export type DraftedRuleType = 'any' | 'submission' | 'comment';
export type DraftedTextFieldName = 'title' | 'body' | 'title+body' | 'domain';
export type DraftedTextModifier = 'includes-word' | 'includes' | 'regex';

export type DraftedTextField = {
  name: DraftedTextFieldName;
  modifier: DraftedTextModifier;
  values: string[];
};

export type DraftedRule = {
  type?: DraftedRuleType;
  action: ApiAction;
  actionReason?: string;
  textFields?: DraftedTextField[];
  author?: {
    commentKarma?: string;
    postKarma?: string;
    accountAge?: string;
  };
  isEdited?: boolean;
  reports?: string;
};

function indent(value: string, spaces: number): string {
  return `${' '.repeat(spaces)}${value}`;
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function pushTextField(lines: string[], field: DraftedTextField): void {
  lines.push(`${field.name}:`);
  lines.push(indent(`${field.modifier}:`, 2));
  for (const value of field.values) {
    lines.push(indent(`- ${quoteYamlString(value)}`, 4));
  }
}

export function buildRuleYaml(draft: DraftedRule): string {
  const lines: string[] = [];

  lines.push(`type: ${draft.type ?? 'any'}`);

  for (const field of draft.textFields ?? []) {
    if (field.values.length > 0) {
      pushTextField(lines, field);
    }
  }

  if (draft.author) {
    const authorLines: string[] = [];
    if (draft.author.commentKarma) {
      authorLines.push(indent(`comment_karma: ${quoteYamlString(draft.author.commentKarma)}`, 2));
    }
    if (draft.author.postKarma) {
      authorLines.push(indent(`link_karma: ${quoteYamlString(draft.author.postKarma)}`, 2));
    }
    if (draft.author.accountAge) {
      authorLines.push(indent(`account_age: ${quoteYamlString(draft.author.accountAge)}`, 2));
    }
    if (authorLines.length > 0) {
      lines.push('author:');
      lines.push(...authorLines);
    }
  }

  if (draft.isEdited !== undefined) {
    lines.push(`is_edited: ${draft.isEdited ? 'true' : 'false'}`);
  }

  if (draft.reports) {
    lines.push(`reports: ${quoteYamlString(draft.reports)}`);
  }

  lines.push(`action: ${draft.action}`);
  if (draft.actionReason) {
    lines.push(`action_reason: ${quoteYamlString(draft.actionReason)}`);
  }

  return `${lines.join('\n')}\n`;
}

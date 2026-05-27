export type ThemeId = 'reddit';

export type Theme = {
  id: ThemeId;
  label: string;
  vars: Record<string, string>;
  monacoTheme: 'vs';
  rootClass: string;
};

export const REDDIT_THEME: Theme = {
  id: 'reddit',
  label: 'Reddit',
  monacoTheme: 'vs',
  rootClass: 'theme-reddit',
  vars: {
    '--bg': '#dae0e6',
    '--bg-2': '#ffffff',
    '--bg-3': '#f6f7f8',
    '--border': '#edeff1',
    '--border-strong': '#ccc',
    '--border-focus': '#0079d3',
    '--text': '#1c1c1c',
    '--text-2': '#545452',
    '--text-3': '#878a8c',
    '--accent': '#ff4500',
    '--accent-hover': '#e03d00',
    '--accent-2': '#0079d3',
    '--accent-2-hover': '#006cbf',
    '--accent-glow': 'none',
    '--action-remove': '#ea0027',
    '--action-filter': '#ffb000',
    '--action-report': '#0079d3',
    '--action-approve': '#46d160',
    '--tab-active': '#ff4500',
    '--btn-primary': '#ff4500',
    '--btn-danger': '#ea0027',
    '--radius': '4px',
    '--font-ui': '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
    '--font-body': '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  },
};

export const THEMES: Theme[] = [REDDIT_THEME];
export const DEFAULT_THEME: ThemeId = 'reddit';

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const t of THEMES) root.classList.remove(t.rootClass);
  root.classList.add(theme.rootClass);
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
}

export function getStoredTheme(): ThemeId {
  return DEFAULT_THEME;
}

export function storeTheme(_id: ThemeId): void {
  return;
}

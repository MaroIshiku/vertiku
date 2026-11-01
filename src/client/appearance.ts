import { useEffect, useState } from 'react';

export type Theme = 'lavender' | 'mint' | 'sky' | 'amber' | 'rose' | 'graphite';
export type Mode = 'system' | 'light' | 'dark';
export const THEMES: Theme[] = ['lavender', 'mint', 'sky', 'amber', 'rose', 'graphite'];
export const MODES: Mode[] = ['system', 'light', 'dark'];

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const value = localStorage.getItem(key) as T | null; return value && allowed.includes(value) ? value : fallback; }
  catch { return fallback; }
}

/** Applies one of the six themes and light/dark/system mode to the document and remembers the choice per browser. */
export function useAppearance() {
  const [theme, setTheme] = useState<Theme>(() => stored('vertiku-theme', THEMES, 'lavender'));
  const [mode, setMode] = useState<Mode>(() => stored('vertiku-mode', MODES, 'system'));
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.mode = mode;
      document.documentElement.dataset.resolvedMode = mode === 'system' ? media.matches ? 'dark' : 'light' : mode;
    };
    apply();
    media.addEventListener('change', apply);
    try { localStorage.setItem('vertiku-theme', theme); localStorage.setItem('vertiku-mode', mode); } catch { /* Storage may be unavailable; the choice still applies. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme, mode]);
  return { theme, setTheme, mode, setMode };
}

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Language = 'nl' | 'en';
export type Theme = 'light' | 'dark' | 'contrast';
export type TextSize = 'normal' | 'large' | 'larger';

interface Prefs {
  language: Language;
  theme: Theme;
  textSize: TextSize;
  setLanguage: (l: Language) => void;
  setTheme: (t: Theme) => void;
  setTextSize: (s: TextSize) => void;
  /** The text in the person's language: t('Opslaan', 'Save'). */
  t: (nl: string, en: string) => string;
}

const PrefsContext = createContext<Prefs | null>(null);

function read<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window: the choice lasts for this visit only */
  }
}

/** Language, theme and text size: chosen by the person, remembered on this device. */
export function PrefsProvider({ children, defaultLanguage = 'nl' }: { children: ReactNode; defaultLanguage?: Language }) {
  const [language, setLanguageState] = useState<Language>(() => read('juspol.lang', ['nl', 'en'], defaultLanguage));
  const [theme, setThemeState] = useState<Theme>(() =>
    read('juspol.theme', ['light', 'dark', 'contrast'], window.matchMedia?.('(prefers-contrast: more)').matches ? 'contrast' : 'light'),
  );
  const [textSize, setTextSizeState] = useState<TextSize>(() => read('juspol.text', ['normal', 'large', 'larger'], 'normal'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.text = textSize;
    document.documentElement.lang = language;
  }, [theme, textSize, language]);

  const setLanguage = useCallback((l: Language) => {
    setLanguageState(l);
    write('juspol.lang', l);
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    write('juspol.theme', t);
  }, []);
  const setTextSize = useCallback((s: TextSize) => {
    setTextSizeState(s);
    write('juspol.text', s);
  }, []);
  const t = useCallback((nl: string, en: string) => (language === 'en' ? en : nl), [language]);

  const value = useMemo(() => ({ language, theme, textSize, setLanguage, setTheme, setTextSize, t }), [language, theme, textSize, setLanguage, setTheme, setTextSize, t]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  const v = useContext(PrefsContext);
  if (!v) throw new Error('PrefsProvider missing');
  return v;
}

export function useT() {
  return usePrefs().t;
}

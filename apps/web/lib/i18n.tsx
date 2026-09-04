'use client';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import en from '@/messages/en';

/**
 * Localization architecture (spec §46).
 *
 * English ships; the point of this file is that adding Urdu, Arabic, Hindi or
 * Spanish later requires no component changes — only a messages file and a
 * locale switch.
 *
 * Two things are handled now because retrofitting them is expensive:
 *
 * **Direction.** Arabic and Urdu are RTL. `dir` is derived from the locale and
 * set on <html>, so Tailwind's logical properties flip automatically. Adding
 * RTL after the fact means auditing every `ml-`/`pl-` in the codebase.
 *
 * **Plurals and interpolation.** Handled by Intl.PluralRules rather than
 * `count === 1 ? 'x' : 'xs'`, which is wrong in Arabic (six plural forms) and
 * Polish (three).
 */

export type Locale = 'en' | 'ur' | 'ar' | 'hi' | 'es';
export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

const RTL: Locale[] = ['ur', 'ar'];
export const isRtl = (l: Locale) => RTL.includes(l);

interface I18n {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  plural: (count: number, forms: Partial<Record<Intl.LDMLPluralRule, string>>) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ locale = 'en', children }: {
  locale?: Locale; children: ReactNode;
}) {
  const value = useMemo<I18n>(() => {
    // Only English exists today; the lookup falls back rather than throwing so
    // a missing translation degrades to English instead of a blank screen.
    const messages: Messages = en;
    const rules = new Intl.PluralRules(locale);

    return {
      locale,
      dir: isRtl(locale) ? 'rtl' : 'ltr',
      t: (key, vars) => {
        let out = messages[key] ?? String(key);
        if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
        return out;
      },
      plural: (count, forms) =>
        (forms[rules.select(count)] ?? forms.other ?? '').replaceAll('{count}', String(count)),
    };
  }, [locale]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  // Usable outside the provider so a component is never coupled to it.
  return ctx ?? {
    locale: 'en', dir: 'ltr',
    t: k => (en as Messages)[k] ?? String(k),
    plural: (c, f) => (f.other ?? '').replaceAll('{count}', String(c)),
  };
}

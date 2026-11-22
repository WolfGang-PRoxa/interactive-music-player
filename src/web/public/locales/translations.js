/**
 * Dashboard i18n Translations Loader
 */
window.translations = {};

async function loadLocale(lang) {
  if (window.translations[lang]) return window.translations[lang];
  try {
    const res = await fetch(`locales/${lang}.json`);
    if (res.ok) {
      const data = await res.json();
      window.translations[lang] = data;
      return data;
    }
  } catch (e) {
    console.error(`[i18n] Error loading language ${lang}:`, e);
  }
  return null;
}

// Précharger la langue courante et les langues disponibles (fr, en, es, de)
(async function initTranslations() {
  let savedLang = 'fr';
  try {
    const savedSettings = localStorage.getItem('dashboardAdvancedSettings');
    if (savedSettings) {
      const parsed = JSON.parse(savedSettings);
      if (parsed.language) savedLang = parsed.language;
    }
  } catch (e) {}

  await loadLocale(savedLang);
  const languages = ['fr', 'en', 'es', 'de'];
  for (const lang of languages) {
    if (lang !== savedLang) {
      loadLocale(lang).catch(() => {});
    }
  }
})();

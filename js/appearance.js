// Applies theme and text-size settings to the document.
export function applyAppearance(settings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty('--fs', String(settings.fontScale));
}

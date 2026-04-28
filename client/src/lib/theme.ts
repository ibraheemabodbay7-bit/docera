export function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

export function setDarkMode(dark: boolean) {
  if (dark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  localStorage.setItem('docera_dark_mode', dark ? 'true' : 'false');
  document.body.style.backgroundColor = dark ? '#0a0a0c' : '#ececef';
  if (typeof window !== 'undefined') {
    let metaTheme = document.querySelector('meta[name="theme-color"]:not([media])') as HTMLMetaElement;
    if (!metaTheme) {
      metaTheme = document.createElement('meta') as HTMLMetaElement;
      metaTheme.name = 'theme-color';
      document.head.appendChild(metaTheme);
    }
    metaTheme.content = dark ? '#0a0a0c' : '#ececef';
  }
}

export function initDarkMode() {
  const stored = localStorage.getItem('docera_dark_mode');
  const dark = stored === 'true';
  setDarkMode(dark);
}

export function toggleDarkMode() {
  setDarkMode(!isDarkMode());
}

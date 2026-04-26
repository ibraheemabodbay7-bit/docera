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
  document.body.style.backgroundColor = dark ? '#00332a' : '#fef7ed';
  if (typeof window !== 'undefined') {
    const metaTheme = document.querySelector('meta[name="theme-color"]:not([media])')
      || document.createElement('meta');
    (metaTheme as HTMLMetaElement).name = 'theme-color';
    (metaTheme as HTMLMetaElement).content = dark ? '#00332a' : '#fef7ed';
    if (!metaTheme.parentNode) document.head.appendChild(metaTheme);

    try {
      import('@capacitor/status-bar').then(({ StatusBar, Style }) => {
        StatusBar.setBackgroundColor({ color: dark ? '#00332a' : '#fef7ed' });
        StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
      }).catch(() => {});
    } catch {}
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

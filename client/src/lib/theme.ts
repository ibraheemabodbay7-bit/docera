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
}

export function initDarkMode() {
  const stored = localStorage.getItem('docera_dark_mode');
  const dark = stored === 'true';
  setDarkMode(dark);
}

export function toggleDarkMode() {
  setDarkMode(!isDarkMode());
}

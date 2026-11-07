import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

// Tema: sistema → oscuro → claro. Se guarda en el navegador; index.html lo
// aplica antes de pintar para que no haya destellos al cargar.
const KEY = 'nn:theme';
const NEXT = { system: 'dark', dark: 'light', light: 'system' };
const ICONS = { system: Monitor, dark: Moon, light: Sun };
const TITLE = {
  system: 'Tema: el del sistema (pulsa para oscuro)',
  dark: 'Tema: oscuro (pulsa para claro)',
  light: 'Tema: claro (pulsa para seguir al sistema)',
};

function read() {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(read);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {}
    const dark = theme === 'dark' || (theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e0f12' : '#ffffff');
  }, [theme]);

  return (
    <button className="theme-toggle" onClick={() => setTheme(NEXT[theme])} title={TITLE[theme]} aria-label={TITLE[theme]}>
      {(() => {
        const Icon = ICONS[theme];
        return <Icon size={15} strokeWidth={1.8} />;
      })()}
    </button>
  );
}

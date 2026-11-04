// Light/dark switch: shadcn's mode-toggle icons (sun and moon rotate and scale past each other)
// plus a page cross-fade. Follows the system setting until the person picks a theme, then keeps it.
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';

export const THEME_KEY = 'clearhire-theme'; // also read by the pre-paint script in index.html

const root = () => document.documentElement;

function stored(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null; // storage blocked: the theme still works, it just is not remembered
  }
}

/** Sets the theme, cross-fading the page where supported unless reduced motion is on. */
function apply(dark: boolean, onDone: (dark: boolean) => void) {
  const set = () => {
    root().classList.toggle('dark', dark);
    onDone(dark);
  };
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !calm) document.startViewTransition(set);
  else set();
}

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(() => root().classList.contains('dark'));

  // Track the system setting while no choice is stored.
  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = (e: MediaQueryListEvent) => {
      if (!stored()) apply(e.matches, setDark);
    };
    system.addEventListener('change', follow);
    return () => system.removeEventListener('change', follow);
  }, []);

  const toggle = () => {
    const next = !dark;
    try {
      localStorage.setItem(THEME_KEY, next ? 'dark' : 'light');
    } catch {
      // not remembered; still switches for this visit
    }
    apply(next, setDark);
  };

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Dark mode"
      aria-pressed={dark}
      onClick={toggle}
      className={`relative ${className ?? ''}`}
    >
      <Sun className="size-4 scale-100 rotate-0 transition-transform duration-300 ease-out dark:scale-0 dark:-rotate-90" />
      <Moon className="absolute size-4 scale-0 rotate-90 transition-transform duration-300 ease-out dark:scale-100 dark:rotate-0" />
    </Button>
  );
}

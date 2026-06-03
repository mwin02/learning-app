import type { Viewport } from 'next';
import type { ReactNode } from 'react';
import { PlaygroundNav } from './PlaygroundNav';

// Force light mode for the playground regardless of OS preference. The root
// globals.css flips to a dark palette under prefers-color-scheme: dark, which
// makes the form/inputs hard to read here. `colorScheme: 'light'` tells the
// browser to render form controls in light mode; the inline style pins the
// background/text so the global CSS variables don't take over. colorScheme
// lives on the viewport export (not metadata) in this Next.js version.
export const viewport: Viewport = {
  colorScheme: 'light',
};

export default function PlaygroundLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ colorScheme: 'light', background: '#ffffff', color: '#171717' }}>
      <PlaygroundNav />
      {children}
    </div>
  );
}

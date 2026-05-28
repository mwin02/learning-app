import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Force light mode for the playground regardless of OS preference. The root
// globals.css flips to a dark palette under prefers-color-scheme: dark, which
// makes the form/inputs hard to read here. `colorScheme: 'light'` tells the
// browser to render form controls in light mode; the inline style pins the
// background/text so the global CSS variables don't take over.
export const metadata: Metadata = {
  colorScheme: 'light',
};

export default function PlaygroundLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ colorScheme: 'light', background: '#ffffff', color: '#171717' }}>
      {children}
    </div>
  );
}

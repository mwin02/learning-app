'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/playground/path-generation', label: 'Path generation' },
  { href: '/playground/programs', label: 'Programs' },
  { href: '/playground/failed-builds', label: 'Failed builds' },
  { href: '/playground/concept-maps', label: 'Concept maps' },
  { href: '/playground/resource', label: 'Resource' },
  { href: '/playground/human-review', label: 'Human review' },
  { href: '/playground/pending-review', label: 'Pending review' },
] as const;

export function PlaygroundNav() {
  const pathname = usePathname();

  return (
    <nav className="border-b bg-gray-50">
      <div className="flex items-center gap-1 px-6">
        <span className="mr-3 py-3 text-sm font-semibold text-gray-700">Playground</span>
        {TABS.map((tab) => {
          // A tab is active for its own page and any nested detail route
          // (e.g. /playground/resource/<id> keeps the Resource tab lit).
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`-mb-px border-b-2 px-3 py-3 text-sm ${
                active
                  ? 'border-black font-medium text-black'
                  : 'border-transparent text-gray-600 hover:text-black'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

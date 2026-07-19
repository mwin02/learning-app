'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Ordered operator-first: the dashboard, then the action queues (things waiting
// on a human decision), then the monitors/browsers. Resource detail pages
// (/playground/resource/[id]) are reached via the dashboard's ID lookup, not a tab.
const TABS = [
  { href: '/playground/dashboard', label: 'Dashboard' },
  { href: '/playground/decomposition-review', label: 'Decomposition review' },
  { href: '/playground/pending-review', label: 'Pending review' },
  { href: '/playground/failed-builds', label: 'Failed builds' },
  { href: '/playground/broken-tracks', label: 'Broken tracks' },
  { href: '/playground/map-review', label: 'Map review' },
  { href: '/playground/queue', label: 'Queue' },
  { href: '/playground/paths', label: 'Paths' },
  { href: '/playground/programs', label: 'Programs' },
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

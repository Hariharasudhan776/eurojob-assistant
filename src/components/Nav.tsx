'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/jobs', label: 'Jobs', icon: '🌍' },
  { href: '/applications', label: 'Applications', icon: '📋' },
  { href: '/profile', label: 'My Profile', icon: '👤' },
  { href: '/settings', label: 'Settings', icon: '⚙️' },
];

export function Nav({ isAdmin = false, pending = 0 }: { isAdmin?: boolean; pending?: number }) {
  const pathname = usePathname();
  const items = isAdmin ? [...NAV, { href: '/admin', label: 'Admin', icon: '🛡️' }] : NAV;
  return (
    <nav className="flex flex-wrap items-center gap-1.5 text-sm">
      {items.map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        const showBadge = item.href === '/admin' && pending > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`relative inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-semibold transition-all ${
              active
                ? 'text-white shadow-lg'
                : 'text-[var(--color-muted)] hover:bg-white/5 hover:text-[var(--color-fg)]'
            }`}
            style={active ? { backgroundImage: 'var(--grad-brand)' } : undefined}
          >
            <span className="text-xs">{item.icon}</span>
            {item.label}
            {showBadge && (
              <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-bad)] px-1 text-[10px] font-bold text-white">
                {pending}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

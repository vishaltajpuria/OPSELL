"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/strategy", label: "Strategy", icon: "\u{1F916}" },
  { href: "/paper", label: "Trade", icon: "\u{1F4DD}" },
  { href: "/positions", label: "Positions", icon: "\u{1F4BC}" },
  { href: "/performance", label: "Performance", icon: "\u{1F4C8}" },
  { href: "/settings", label: "Settings", icon: "\u{2699}\u{FE0F}" },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-surface safe-bottom">
      <div className="mx-auto flex max-w-md">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname?.startsWith(tab.href + "/");
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs ${
                active ? "text-accent" : "text-muted"
              }`}
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

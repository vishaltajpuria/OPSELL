"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

// The page content scrolls inside this element instead of the document, so
// iOS rubber-banding / momentum scrolling can never drag the bottom nav along.
export default function ScrollArea({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const pathname = usePathname();

  // Start each page at the top, like a normal page load would.
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <main ref={ref} className="app-scroll">
      <div className="mx-auto max-w-md pb-4">{children}</div>
    </main>
  );
}

import type { ReactNode } from "react";

export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b-(length:--rule-thick) border-amber bg-header">
      <div className="mx-auto flex max-w-(--size-page) flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
        <h1 className="text-title font-black tracking-wordmark text-amber uppercase">Swiftlet</h1>
        {children}
      </div>
    </header>
  );
}

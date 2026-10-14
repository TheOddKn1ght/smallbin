import type { MouseEventHandler, ReactNode } from "react";

interface SiteLayoutProps {
  path: string;
  children: ReactNode;
  onNavigate?: MouseEventHandler<HTMLAnchorElement>;
  onSkipToContent?: MouseEventHandler<HTMLAnchorElement>;
}

export function SiteLayout({ path, children, onNavigate, onSkipToContent }: SiteLayoutProps) {
  return <div className="site-shell">
    <a className="skip-link" href="#main" onClick={onSkipToContent}>Skip to content</a>
    <header className="site-header">
      <a className="brand" href="/" aria-label="Smallbin home" onClick={onNavigate}>smallbin</a>
      <nav aria-label="Main navigation">
        <a href="/" aria-current={path === "/" ? "page" : undefined} onClick={onNavigate}>New bin</a>
        <a href="/privacy" aria-current={path === "/privacy" ? "page" : undefined} onClick={onNavigate}>Privacy</a>
      </nav>
    </header>
    <main id="main" tabIndex={-1}>{children}</main>
  </div>;
}

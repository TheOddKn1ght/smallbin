import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { CreateBin } from "./components/smallbin/CreateBin";
import { Privacy } from "./components/smallbin/Privacy";
import { ReceiveBin } from "./components/smallbin/ReceiveBin";
import { SiteLayout } from "./components/smallbin/SiteLayout";
import "./index.css";

export function App() {
  const [location, setLocation] = useState(() => ({ path: window.location.pathname, secret: window.location.hash.slice(1) }));
  const focusAfterNavigation = useRef(false);
  useEffect(() => {
    const update = () => setLocation({ path: window.location.pathname, secret: window.location.hash.slice(1) });
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => { window.removeEventListener("hashchange", update); window.removeEventListener("popstate", update); };
  }, []);
  useEffect(() => {
    document.title = location.path === "/privacy" ? "Privacy | Smallbin" : "Smallbin";
  }, [location.path]);
  useEffect(() => {
    if (!focusAfterNavigation.current) return;
    focusAfterNavigation.current = false;
    document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location]);

  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.currentTarget;
    if ((link.target && link.target !== "_self") || link.hasAttribute("download")) return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin || (url.pathname !== "/" && url.pathname !== "/privacy")) return;
    // Clicking New bin while already creating one should still reset the page.
    if (url.pathname === window.location.pathname) return;
    event.preventDefault();
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    focusAfterNavigation.current = true;
    setLocation({ path: url.pathname, secret: url.hash.slice(1) });
  }

  const { path, secret } = location;
  const match = path.match(/^\/b\/([A-Za-z0-9_-]{16,128})$/);
  return <SiteLayout path={path} onNavigate={navigate} onSkipToContent={event => { event.preventDefault(); document.getElementById("main")?.focus(); }}>
      {path === "/privacy" ? <Privacy /> : match ? <ReceiveBin id={match[1]!} secret={secret} /> : path === "/" ? <CreateBin /> : <section className="not-found"><h1>Page not found</h1><a className="text-button" href="/">Create a new bin</a></section>}
  </SiteLayout>;
}

export default App;

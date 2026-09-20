import { useEffect, useState } from "react";
import { CreateBin } from "./components/smallbin/CreateBin";
import { Privacy } from "./components/smallbin/Privacy";
import { ReceiveBin } from "./components/smallbin/ReceiveBin";
import "./index.css";

export function App() {
  const [location, setLocation] = useState(() => ({ path: window.location.pathname, secret: window.location.hash.slice(1) }));
  useEffect(() => {
    const update = () => setLocation({ path: window.location.pathname, secret: window.location.hash.slice(1) });
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => { window.removeEventListener("hashchange", update); window.removeEventListener("popstate", update); };
  }, []);
  const { path, secret } = location;
  const match = path.match(/^\/b\/([A-Za-z0-9_-]{16,128})$/);
  return <div className="site-shell">
    <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
    <header className="site-header">
      <a className="brand" href="/" aria-label="Smallbin home">smallbin</a>
      <nav aria-label="Main navigation">
        <a href="/" aria-current={path === "/" ? "page" : undefined}>New bin</a>
        <a href="/privacy" aria-current={path === "/privacy" ? "page" : undefined}>Privacy</a>
      </nav>
    </header>
    <main id="main" tabIndex={-1}>
      {path === "/privacy" ? <Privacy /> : match ? <ReceiveBin id={match[1]!} secret={secret} /> : path === "/" ? <CreateBin /> : <section className="not-found"><h1>Page not found</h1><a className="text-button" href="/">Create a new bin</a></section>}
    </main>
  </div>;
}

export default App;

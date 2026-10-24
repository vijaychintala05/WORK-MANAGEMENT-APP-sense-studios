import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

/** Shared landmarks for existing routes; no reload or navigation-state reset. */
export function RouteAccessibility(): React.JSX.Element {
  const { pathname } = useLocation();
  const [target, setTarget] = useState("sense-main");
  useEffect(() => {
    let resolved = false;
    const identify = (): void => {
      const main = document.querySelector<HTMLElement>("main");
      if (!main) return;
      if (!main.id) main.id = "sense-main";
      main.tabIndex = -1;
      setTarget(main.id);
      const heading = main.querySelector<HTMLElement>("h1,h2");
      if (!heading || resolved) return;
      resolved = true;
      if (!document.querySelector("dialog[open]")) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      observer.disconnect();
    };
    const observer = new MutationObserver(identify);
    observer.observe(document.body, { childList: true, subtree: true });
    identify();
    return () => observer.disconnect();
  }, [pathname]);
  return <a className="sense-skip-link" href={`#${target}`} onClick={event => { const main = document.getElementById(target); if (main) { event.preventDefault(); main.focus(); main.scrollIntoView({ block: "start" }); } }}>Skip to main content</a>;
}

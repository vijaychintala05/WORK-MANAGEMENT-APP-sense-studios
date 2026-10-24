import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { App } from "./app.js";
import "./styles.css";
import "./studio-theme.css";
import { PhoneInstall, PwaUpdateNotice } from "./pwa-delivery.js";
import { ReleaseStatus } from "./release-status.js";
import { RouteAccessibility } from "./route-accessibility.js";
import "./ux-usability.css";
// Load the shared shell after module styles so every internal route uses one frame.
import "./my-work-shell.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");
const ClientPortalAuth = React.lazy(async () => ({ default: (await import("./client-portal-auth.js")).ClientPortalAuth }));
const ExternalPortalWorkspace = React.lazy(async () => ({ default: (await import("./external-portal.js")).ExternalPortalWorkspace }));
const PublicPortfolioPage = React.lazy(async () => ({ default: (await import("./gallery.js")).PublicPortfolioPage }));

createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <RouteAccessibility />
      <PwaUpdateNotice />
      <Routes>
        <Route path="/install" element={<PhoneInstall />} />
        <Route path="/client-portal/*" element={<React.Suspense fallback={<p role="status">Loading client portal…</p>}><ClientPortalAuth /></React.Suspense>} />
        <Route path="/external-portal/*" element={<React.Suspense fallback={<p role="status">Loading external portal…</p>}><ExternalPortalWorkspace /></React.Suspense>} />
        <Route path="/portfolio" element={<React.Suspense fallback={<p role="status">Loading portfolio…</p>}><PublicPortfolioPage /></React.Suspense>} />
        <Route path="*" element={<App />} />
      </Routes>
      <ReleaseStatus />
    </BrowserRouter>
  </React.StrictMode>
);

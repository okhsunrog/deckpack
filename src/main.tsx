import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { loadDefaultConfig } from "./data/defaults";
import { loadEnclosureAssets } from "./data/enclosures";

// Imported enclosures must be known before the persisted project is restored,
// otherwise a project built on one of them would fall back to the defaults.
try {
  await loadEnclosureAssets();
} catch (error) {
  console.error("Enclosure registry unavailable, using bundled assets only", error);
}
// The default project (tolerance stack, service reservations) lives in the
// Rust core; the store clones it, so it has to be here before the store loads.
await loadDefaultConfig();
const { default: App } = await import("./App.tsx");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

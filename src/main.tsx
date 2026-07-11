import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AppProviders } from "./AppProviders";
import "./styles.css";

const root = document.getElementById("root");

async function bootstrap() {
  if (!root) {
    throw new Error("Root element was not found.");
  }

  if (import.meta.env.MODE === "e2e") {
    await import("@wdio/tauri-plugin");
  }

  createRoot(root).render(
    <StrictMode>
      <AppProviders>
        <App />
      </AppProviders>
    </StrictMode>,
  );
}

void bootstrap();

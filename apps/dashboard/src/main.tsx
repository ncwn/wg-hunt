import "@fontsource-variable/manrope";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { createApiClient } from "./api/client.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/searches.css";
import "./styles/offers.css";
import "./styles/offer-detail.css";
import "./styles/profile.css";
import "./styles/settings.css";
import "./styles/crawl.css";
import "./styles/overview.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App api={createApiClient()} />
    </BrowserRouter>
  </StrictMode>,
);

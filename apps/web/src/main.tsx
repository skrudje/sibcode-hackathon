import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { desktop } from "./transport";
import App from "./App";
import "./styles.css";
import "./workspace.css";

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 3000 } },
});
const Router = desktop ? HashRouter : BrowserRouter;
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <Router>
        <App />
      </Router>
    </QueryClientProvider>
  </React.StrictMode>,
);

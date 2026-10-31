import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// Ошибки вне React (сокет, таймеры, промисы) не должны исчезать молча:
// панель имеет дело с недоверенными данными плагинов и воркера.
window.addEventListener("error", (event) => console.error("[panel] необработанная ошибка:", event.message, event.error));
window.addEventListener("unhandledrejection", (event) => console.error("[panel] необработанный промис:", event.reason));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary label="Панель">
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { connect } from "wagmi/actions";
import { App } from "./App";
import { MOCK } from "./config";
import "./styles.css";
import { wagmiConfig } from "./wagmi";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 1000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig} reconnectOnMount={!MOCK}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);

if (import.meta.env.DEV && MOCK) {
  // Dev-only: start with the fake wallet already connected. Deferred so it
  // runs after WagmiProvider's mount effect, which resets connections.
  setTimeout(() => {
    connect(wagmiConfig, { connector: wagmiConfig.connectors[0]! }).catch(console.error);
  }, 0);
}

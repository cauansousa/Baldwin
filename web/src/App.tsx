import { useCallback, useState } from "react";
import { useAccount } from "wagmi";
import { AccountPanel } from "./components/AccountPanel";
import { Header } from "./components/Header";
import { OpenOrdersTable } from "./components/OpenOrdersTable";
import { OrderBookPanel } from "./components/OrderBookPanel";
import { OrderForm, type OrderPrefill } from "./components/OrderForm";
import { PositionsTable } from "./components/PositionsTable";
import { TradesPanel } from "./components/TradesPanel";
import { config } from "./config";
import { useChainAccount, useChainMarkets, useExchangeStatus } from "./hooks/useChain";
import { useMarketFeed, useMarkets } from "./hooks/useEngine";
import { describeError } from "./lib/errors";

export function App() {
  const marketsQuery = useMarkets();
  const markets = marketsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<number>();
  const market = markets.find((m) => m.marketId === selectedId) ?? markets[0];

  const { address, isConnected, chainId: walletChainId } = useAccount();
  const wrongNetwork = isConnected && walletChainId !== config.chainId;
  // Signing and sending are only offered when everything lines up.
  const trader = isConnected && !wrongNetwork ? address : undefined;

  const chainMarkets = useChainMarkets(markets);
  const account = useChainAccount(address, markets);
  const exchangeStatus = useExchangeStatus();
  const feed = useMarketFeed(market?.marketId);
  const chainMarket = market ? chainMarkets.data?.get(market.marketId) : undefined;

  const [prefill, setPrefill] = useState<OrderPrefill>();
  const onClosePosition = useCallback((p: Omit<OrderPrefill, "key">) => {
    setSelectedId(p.marketId);
    setPrefill({ ...p, key: Date.now() });
    document.getElementById("order-form")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  return (
    <div className="app">
      <Header
        markets={markets}
        market={market}
        onSelectMarket={setSelectedId}
        chainMarket={chainMarket}
        live={feed.live}
        wrongNetwork={wrongNetwork}
      />

      {!config.exchange && (
        <div className="banner banner-warn" role="alert">
          Endereço do contrato não configurado. Defina <code>VITE_EXCHANGE_ADDRESS</code> e{" "}
          <code>VITE_USDC_ADDRESS</code> ou gere <code>contracts/deployments/localhost.json</code>.
        </div>
      )}
      {marketsQuery.isError && (
        <div className="banner banner-error" role="alert">
          Motor de ordens indisponível em <code>{config.engineUrl}</code>: {describeError(marketsQuery.error)}
        </div>
      )}
      {chainMarkets.isError && (
        <div className="banner banner-error" role="alert">
          Não foi possível ler a blockchain em <code>{config.rpcUrl}</code>: {describeError(chainMarkets.error)}
        </div>
      )}

      {exchangeStatus.data?.paused && (
        <div className="banner banner-warn" role="alert">
          A exchange está pausada: apenas ordens que reduzem posição serão executadas. Depósitos, saques e
          cancelamentos continuam funcionando.
        </div>
      )}

      <main className="main">
        <div className="col-left">
          <div className="market-row">
            <OrderBookPanel book={feed.book.data} loading={feed.book.isLoading} error={feed.book.error} />
            <TradesPanel trades={feed.trades.data} loading={feed.trades.isLoading} error={feed.trades.error} />
          </div>
          <div className="tables">
            <PositionsTable
              markets={markets}
              chainMarkets={chainMarkets.data}
              account={account.data}
              connected={isConnected}
              onClose={onClosePosition}
            />
            <OpenOrdersTable markets={markets} viewer={address} trader={trader} />
          </div>
        </div>
        <div className="col-right">
          <OrderForm
            market={market}
            chainMarket={chainMarket}
            account={account.data}
            exchangeStatus={exchangeStatus.data}
            trader={trader}
            prefill={prefill}
          />
          <AccountPanel account={account.data} loadError={account.error} trader={trader} connected={isConnected} />
        </div>
      </main>
    </div>
  );
}

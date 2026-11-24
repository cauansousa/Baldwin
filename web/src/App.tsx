import { useCallback, useState } from "react";
import { useAccount } from "wagmi";
import { AccountPanel } from "./components/AccountPanel";
import { Header } from "./components/Header";
import { MarketBar } from "./components/MarketBar";
import { ProtocolPanel } from "./components/ProtocolPanel";
import { OpenOrdersTable } from "./components/OpenOrdersTable";
import { OrderBookPanel } from "./components/OrderBookPanel";
import { OrderForm, type OrderPrefill } from "./components/OrderForm";
import { PositionsTable } from "./components/PositionsTable";
import { TradesPanel } from "./components/TradesPanel";
import { ExplorerLink } from "./components/TxStatus";
import { chain, config, isLocalChain } from "./config";
import { useChainAccount, useChainMarkets, useExchangeStatus } from "./hooks/useChain";
import { useEngineHealth, useMarketFeed, useMarkets } from "./hooks/useEngine";
import { describeError } from "./lib/errors";

const TESTNET_NOTICE_KEY = "baldwin.testnet-notice-dismissed";

// sessionStorage can throw (private mode, blocked storage); the notice then simply reappears.
function readSessionFlag(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeSessionFlag(key: string): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    /* ignore */
  }
}

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
  const health = useEngineHealth();
  const engineHasFigures = health.data?.insuranceFund !== undefined && health.data.totalBadDebt !== undefined;
  const exchangeStatus = useExchangeStatus(engineHasFigures);
  const engineMarket = market ? health.data?.markets.find((m) => m.marketId === market.marketId) : undefined;
  // The contract is the authority; the engine's view is the fallback while the chain read is unavailable.
  const paused = exchangeStatus.data?.paused ?? health.data?.paused ?? false;
  // While recovering the engine has not read prices yet; that is not a halted market.
  const halted = engineMarket !== undefined && engineMarket.indexPrice === null && !health.data?.recovering;

  // The engine mirrors these two figures; the contract is read only when it does not.
  const protocolStatus =
    exchangeStatus.data || health.data
      ? {
          ...exchangeStatus.data,
          insuranceFund: health.data?.insuranceFund ?? exchangeStatus.data?.insuranceFund,
          totalBadDebt: health.data?.totalBadDebt ?? exchangeStatus.data?.totalBadDebt,
        }
      : undefined;

  const [testnetNoticeOpen, setTestnetNoticeOpen] = useState(() => !isLocalChain && !readSessionFlag(TESTNET_NOTICE_KEY));
  const dismissTestnetNotice = () => {
    writeSessionFlag(TESTNET_NOTICE_KEY);
    setTestnetNoticeOpen(false);
  };
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
      {testnetNoticeOpen && (
        <div className="banner banner-testnet" role="note">
          <strong>Rede de testes — não use fundos reais.</strong>
          <button className="btn btn-small" onClick={dismissTestnetNotice} aria-label="Dispensar aviso de rede de testes">
            Entendi
          </button>
        </div>
      )}
      <Header live={feed.live} wrongNetwork={wrongNetwork} />
      <MarketBar
        markets={markets}
        market={market}
        onSelectMarket={setSelectedId}
        chainMarket={chainMarket}
        loading={marketsQuery.isLoading || chainMarkets.isLoading}
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
          <span>
            Não foi possível ler a blockchain em <code>{new URL(config.rpcUrl).host}</code>: {describeError(chainMarkets.error)}{" "}
            {chainMarkets.data ? "Os valores exibidos podem estar desatualizados." : ""}
          </span>
          <button className="btn btn-small" disabled={chainMarkets.isFetching} onClick={() => void chainMarkets.refetch()}>
            {chainMarkets.isFetching ? "Tentando…" : "Tentar agora"}
          </button>
        </div>
      )}
      {health.data?.recovering && (
        <div className="banner banner-warn" role="alert">
          O motor está reiniciando e se sincronizando com a blockchain: novas ordens são temporariamente recusadas.
          Cancelamentos, depósitos e saques continuam funcionando.
        </div>
      )}
      {health.data?.stalled && !health.data.recovering && (
        <div className="banner banner-warn" role="alert">
          O motor está com a liquidação on-chain parada. Ordens casadas podem demorar a ser confirmadas.
        </div>
      )}
      {paused && (
        <div className="banner banner-warn" role="alert">
          A exchange está pausada: apenas ordens que reduzem posição serão executadas. Depósitos, saques e
          cancelamentos continuam funcionando.
        </div>
      )}
      {halted && market && (
        <div className="banner banner-warn" role="alert">
          {market.symbol} está suspenso: o motor não tem um preço índice recente e não aceita novas ordens neste mercado.
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
              loading={account.isLoading}
              loadError={account.error}
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
            engineMarket={engineMarket}
            trader={trader}
            prefill={prefill}
          />
          <AccountPanel
            account={account.data}
            chainMarkets={chainMarkets.data}
            loadError={account.error}
            trader={trader}
            connected={isConnected}
          />
          <ProtocolPanel status={protocolStatus} loading={exchangeStatus.isLoading} error={exchangeStatus.error} paused={paused} />
        </div>
      </main>

      <footer className="footer">
        <span>
          {chain.name} (chain id {config.chainId})
        </span>
        {config.exchange && (
          <span>
            Contrato da exchange:{" "}
            <ExplorerLink kind="address" value={config.exchange}>
              <code>{config.exchange}</code>
            </ExplorerLink>
          </span>
        )}
        <span>Não custodial: as ordens são assinadas na sua carteira; o app nunca vê chaves privadas.</span>
      </footer>
    </div>
  );
}

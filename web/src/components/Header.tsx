import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import type { MarketInfo } from "../api/types";
import { config, MOCK } from "../config";
import type { ChainMarket } from "../hooks/useChain";
import { describeError } from "../lib/errors";
import { formatPrice } from "../lib/units";
import { chain } from "../wagmi";

interface Props {
  markets: MarketInfo[];
  market: MarketInfo | undefined;
  onSelectMarket: (marketId: number) => void;
  chainMarket: ChainMarket | undefined;
  live: boolean;
  wrongNetwork: boolean;
}

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Header({ markets, market, onSelectMarket, chainMarket, live, wrongNetwork }: Props) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const connector = connectors[0];

  return (
    <>
      <header className="header">
        <div className="brand">
          Baldwin
          {MOCK && <span className="tag tag-mock">simulado</span>}
        </div>

        <label className="market-select">
          <span className="sr-only">Mercado</span>
          <select
            value={market?.marketId ?? ""}
            onChange={(e) => onSelectMarket(Number(e.target.value))}
            disabled={markets.length === 0}
          >
            {markets.length === 0 && <option value="">Sem mercados</option>}
            {markets.map((m) => (
              <option key={m.marketId} value={m.marketId}>
                {m.symbol}
              </option>
            ))}
          </select>
        </label>

        <div className="stat">
          <span className="stat-label">Preço índice</span>
          <span className="stat-value num">{chainMarket?.indexPrice ? formatPrice(chainMarket.indexPrice) : "—"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Preço de marca</span>
          <span className="stat-value num">{chainMarket?.markPrice ? formatPrice(chainMarket.markPrice) : "—"}</span>
        </div>
        <div className={`feed-status ${live ? "is-live" : ""}`} title="Conexão em tempo real com o motor de ordens">
          <span className="dot" />
          {live ? "Ao vivo" : "Reconectando…"}
        </div>

        <div className="wallet">
          {isConnected && address ? (
            <>
              <span className="address num" title={address}>
                {shortAddress(address)}
              </span>
              <button className="btn" onClick={() => disconnect()}>
                Desconectar
              </button>
            </>
          ) : (
            <button
              className="btn btn-primary"
              disabled={connecting || !connector}
              onClick={() => connector && connect({ connector, chainId: config.chainId })}
            >
              {connecting ? "Conectando…" : "Conectar carteira"}
            </button>
          )}
        </div>
      </header>

      {wrongNetwork && (
        <div className="banner banner-warn" role="alert">
          <span>
            A carteira está em outra rede. Este app usa {chain.name} (chain id {config.chainId}).
          </span>
          <button className="btn btn-small" disabled={switching} onClick={() => switchChain({ chainId: config.chainId })}>
            {switching ? "Trocando…" : "Trocar de rede"}
          </button>
          {switchError && <span className="banner-detail">{describeError(switchError)}</span>}
        </div>
      )}
      {connectError && !isConnected && (
        <div className="banner banner-error" role="alert">
          {describeError(connectError)}
        </div>
      )}
    </>
  );
}

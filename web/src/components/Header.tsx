import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import type { MarketInfo } from "../api/types";
import { config, MOCK } from "../config";
import type { ChainMarket } from "../hooks/useChain";
import { describeError } from "../lib/errors";
import { formatPrice } from "../lib/units";
import { selectWallets } from "../lib/wallets";
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
  const { connect, isPending: connecting, error: connectError } = useConnect();
  const wallets = selectWallets(useConnectors());
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();

  // Wallet picker, shown when more than one wallet extension is installed.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // The network is switched (or added) afterwards through the banner, so that
  // declining the switch does not undo the connection.
  const connectWith = (connector: (typeof wallets)[number]) => {
    setMenuOpen(false);
    connect({ connector });
  };
  const onConnectClick = () => {
    const only = wallets.length === 1 ? wallets[0] : undefined;
    if (only) connectWith(only);
    else setMenuOpen((open) => !open);
  };

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
            <div className="wallet-menu" ref={menuRef}>
              <button
                className="btn btn-primary"
                disabled={connecting}
                aria-haspopup={wallets.length > 1 ? "menu" : undefined}
                aria-expanded={wallets.length > 1 ? menuOpen : undefined}
                onClick={onConnectClick}
              >
                {connecting ? "Conectando…" : "Conectar carteira"}
              </button>
              {menuOpen && (
                <div className="menu" role="menu">
                  {wallets.length === 0 ? (
                    <div className="menu-empty">Nenhuma carteira encontrada no navegador. Instale a MetaMask ou similar.</div>
                  ) : (
                    wallets.map((w) => (
                      <button key={w.uid} role="menuitem" className="menu-item" onClick={() => connectWith(w)}>
                        {w.icon ? <img src={w.icon} alt="" width={18} height={18} /> : <span className="menu-icon" />}
                        {w.id === "injected" ? "Carteira do navegador" : w.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {wrongNetwork && (
        <div className="banner banner-warn" role="alert">
          <span>
            A carteira está em outra rede. Este app usa {chain.name} (chain id {config.chainId}). Se a rede ainda não
            existir na carteira, ela será adicionada.
          </span>
          <button className="btn btn-small" disabled={switching} onClick={() => switchChain({ chainId: config.chainId })}>
            {switching ? "Abrindo a carteira…" : `Trocar para ${chain.name}`}
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

import { useState } from "react";
import { useWriteContract } from "wagmi";
import { readContract } from "wagmi/actions";
import { USDC_DECIMALS } from "@shared";
import { config, isLocalChain } from "../config";
import type { ChainAccount } from "../hooks/useChain";
import { useTxFlow, type TxStep } from "../hooks/useTx";
import { describeError } from "../lib/errors";
import { marginUsageBps } from "../lib/risk";
import { formatBps, formatUsdc, parseUsdc, toInputString } from "../lib/units";
import { erc20Abi, exchangeAbi, wagmiConfig } from "../wagmi";

const MINT_AMOUNT = 10_000n * 10n ** BigInt(USDC_DECIMALS);

interface Props {
  account: ChainAccount | undefined;
  loadError: unknown;
  /** Connected address on the right network; undefined disables transactions. */
  trader: `0x${string}` | undefined;
  connected: boolean;
}

type Mode = "deposit" | "withdraw";

export function AccountPanel({ account, loadError, trader, connected }: Props) {
  const { writeContractAsync } = useWriteContract();
  const tx = useTxFlow();
  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");

  const { exchange, usdc, chainId } = config;
  const max = mode === "deposit" ? account?.walletUsdc : account?.freeCollateral;
  const parsed = parseUsdc(amount);
  let amountError = parsed.ok ? undefined : parsed.error;
  if (parsed.ok && max !== undefined && parsed.value > max) {
    amountError = mode === "deposit" ? "Saldo de USDC insuficiente na carteira." : "Valor acima do colateral livre.";
  }
  const ready = !!trader && !!exchange && !!usdc;
  const canSend = ready && !tx.busy && parsed.ok && !amountError;

  const usage =
    account?.initialMargin !== undefined && account.accountValue !== undefined
      ? marginUsageBps(account.initialMargin, account.accountValue)
      : undefined;
  const usagePct = usage === null ? 100 : usage === undefined ? 0 : Math.min(100, Number(usage / 100n));

  async function onSubmit() {
    if (!canSend || !parsed.ok || !trader || !exchange || !usdc) return;
    const value = parsed.value;
    const ok =
      mode === "deposit"
        ? await tx.run(async () => {
            // Skip the approval when the current allowance already covers the deposit.
            const allowance = await readContract(wagmiConfig, {
              abi: erc20Abi,
              address: usdc,
              chainId,
              functionName: "allowance",
              args: [trader, exchange],
            });
            const steps: TxStep[] = [];
            if (allowance < value) {
              steps.push({
                label: "Aprovação de USDC",
                send: () =>
                  writeContractAsync({ abi: erc20Abi, address: usdc, chainId, functionName: "approve", args: [exchange, value] }),
              });
            }
            steps.push({
              label: "Depósito",
              send: () => writeContractAsync({ abi: exchangeAbi, address: exchange, chainId, functionName: "deposit", args: [value] }),
            });
            return steps;
          }, "Depósito confirmado.")
        : await tx.run(
            () => [
              {
                label: "Saque",
                send: () =>
                  writeContractAsync({ abi: exchangeAbi, address: exchange, chainId, functionName: "withdraw", args: [value] }),
              },
            ],
            "Saque confirmado.",
          );
    if (ok) setAmount("");
  }

  function onMint() {
    if (!trader || !usdc) return;
    void tx.run(
      () => [
        {
          label: "Emissão de USDC de teste",
          send: () => writeContractAsync({ abi: erc20Abi, address: usdc, chainId, functionName: "mint", args: [trader, MINT_AMOUNT] }),
        },
      ],
      "USDC de teste emitido.",
    );
  }

  const usd = (v: bigint | undefined) => (v !== undefined ? formatUsdc(v) : "—");

  return (
    <section className="panel account">
      <h2 className="panel-title">Conta</h2>
      {!connected ? (
        <div className="empty">Conecte a carteira para ver saldos e margem.</div>
      ) : (
        <>
          {loadError != null && !account && <p className="note note-error">{describeError(loadError)}</p>}
          <dl className="summary">
            <div>
              <dt>USDC na carteira</dt>
              <dd className="num">{usd(account?.walletUsdc)}</dd>
            </div>
            <div>
              <dt>Saldo na exchange</dt>
              <dd className="num">{usd(account?.balance)}</dd>
            </div>
            <div>
              <dt>Valor da conta</dt>
              <dd className="num strong">{usd(account?.accountValue)}</dd>
            </div>
            <div>
              <dt>Colateral livre</dt>
              <dd className="num">{usd(account?.freeCollateral)}</dd>
            </div>
            <div>
              <dt>Uso de margem</dt>
              <dd className="num">{usage === undefined ? "—" : usage === null ? "> 100%" : formatBps(usage)}</dd>
            </div>
          </dl>
          <div
            className={`meter ${usagePct >= 80 ? "is-high" : ""}`}
            role="meter"
            aria-label="Uso de margem"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usagePct}
          >
            <span style={{ width: `${usagePct}%` }} />
          </div>

          <div className="tabs" role="tablist">
            {(["deposit", "withdraw"] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? "active" : ""}
                disabled={tx.busy}
                onClick={() => {
                  setMode(m);
                  setAmount("");
                  tx.reset();
                }}
              >
                {m === "deposit" ? "Depositar" : "Sacar"}
              </button>
            ))}
          </div>

          <label className="field">
            <span className="field-label">
              Valor
              <button
                type="button"
                className="link"
                disabled={max === undefined || tx.busy}
                onClick={() => max !== undefined && setAmount(toInputString(max, USDC_DECIMALS))}
              >
                Máx.: {usd(max)}
              </button>
            </span>
            <span className="input-wrap">
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder="0,00"
                value={amount}
                disabled={tx.busy}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={amount !== "" && !!amountError}
              />
              <span className="suffix">USDC</span>
            </span>
            {amount !== "" && amountError && <span className="field-error">{amountError}</span>}
          </label>

          <button className="btn btn-primary btn-block" disabled={!canSend} onClick={() => void onSubmit()}>
            {!ready ? "Indisponível nesta rede" : mode === "deposit" ? "Depositar USDC" : "Sacar USDC"}
          </button>

          {isLocalChain && (
            <button className="btn btn-block" disabled={!ready || tx.busy} onClick={onMint}>
              Emitir 10.000 USDC de teste
            </button>
          )}

          {tx.state.status === "wallet" && <p className="note" role="status">{tx.state.label}: confirme na carteira…</p>}
          {tx.state.status === "pending" && <p className="note" role="status">{tx.state.label}: aguardando confirmação na rede…</p>}
          {tx.state.status === "success" && <p className="note note-ok" role="status">{tx.state.label}</p>}
          {tx.state.status === "error" && <p className="note note-error" role="alert">{tx.state.message}</p>}
        </>
      )}
    </section>
  );
}

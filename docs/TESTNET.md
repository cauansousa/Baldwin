# Subindo na Arbitrum Sepolia (testnet)

Passo a passo para o primeiro deploy público de testes. Nada aqui foi executado contra
a rede real: o script de deploy, o motor e a tela foram ensaiados apenas numa blockchain
local com simuladores de USDC e Chainlink. Trate a primeira execução como parte do teste.

**Rede de testes. Não use fundos reais nem chaves que guardem fundos reais.**

## 1. O que providenciar antes

| Item | Para quê |
|---|---|
| Provedor de RPC com Arbitrum Sepolia (chain id 421614) | Deploy, motor, bot e tela falam com a rede por ele. Prefira um plano que não distribua as requisições entre nós dessincronizados. |
| Carteira **deployer** com ETH de teste | Envia as transações de deploy. Vira dona temporária dos contratos. |
| Carteira **operador** com ETH de teste | O motor assina os lotes de negociações com ela. Use-a só para isso. |
| Carteira **keeper** com ETH de teste e USDC de teste | O bot de liquidação. Precisa ser diferente do operador e ter USDC depositado na exchange, porque assume as posições que liquida. |
| Multisig (Safe) na Arbitrum Sepolia | Dona final dos contratos. |
| Endereço para receber as taxas | Pode ser o multisig. |
| Chave de API do Etherscan (v2) | Só para publicar o código-fonte no explorador. |
| Servidor com Node 22.13 ou mais recente | Roda o motor e o bot, ligados o tempo todo. |
| Hospedagem de site estático com HTTPS | Serve a tela. |

ETH de teste vem de um faucet da Arbitrum Sepolia; USDC de teste, do faucet da Circle.

## 2. Endereços externos

Procure, não adivinhe. Um endereço errado aponta o protocolo para o contrato errado.

- **USDC de teste:** página "USDC on test networks" da Circle, rede Arbitrum Sepolia.
- **Preços BTC/USD e ETH/USD:** lista "Price Feed Contract Addresses" da Chainlink, rede
  Arbitrum Sepolia. Use o endereço do *proxy* e anote o *heartbeat* de cada um.
- **Sequenciador (opcional):** lista "L2 Sequencer Uptime Feeds" da Chainlink. Se não houver
  para a Arbitrum Sepolia, deixe em branco.

## 3. Deploy dos contratos

```bash
cd contracts
npm install
cp .env.example .env      # preencha; o arquivo .env não vai para o git
npx hardhat test          # deve terminar com todos os testes passando
npm run deploy:testnet
```

No `.env`, além dos endereços acima: `ARBITRUM_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`,
`OWNER_ADDRESS` (o multisig), `OPERATOR_ADDRESS`, `FEE_RECIPIENT` e os dois
`*_MAX_STALENESS` (heartbeat do preço mais uma folga, por exemplo 3600 → 3900).
Deixe `ALLOW_EOA_OWNER` e `ALLOW_TEST_KEY` em `false`.

O script confere tudo antes de gastar gás e se recusa a rodar se faltar variável, se
algum endereço não tiver contrato, se o USDC não tiver 6 casas decimais ou se os preços
parecerem trocados. Ao terminar, ele:

- grava `contracts/deployments/arbitrumSepolia.json`, com os endereços e o bloco do deploy;
- imprime os comandos de verificação do código no explorador;
- avisa que o multisig precisa aceitar a administração.

**Depois do deploy, pelo multisig:** chame `acceptOwnership()` na `Exchange` e no
`ChainlinkOracle`. Até isso acontecer, a carteira deployer continua sendo a dona.

Confira no explorador: `owner()` é o multisig nos dois contratos, `isOperator(operador)` é
`true`, e `indexPrice(0)` e `indexPrice(1)` devolvem preços plausíveis de BTC e ETH.

## 4. Motor e bot de liquidação

```bash
cd engine
npm install
cp .env.testnet.example .env    # preencha
npm test
npm start                        # motor
npm run keeper                   # bot, em outro processo
```

Preencha `RPC_URL`, `OPERATOR_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY` e `CORS_ORIGIN` (a origem
exata do site, com `https://`). `START_BLOCK` e `KEEPER_START_BLOCK` podem ficar em branco:
o padrão é o bloco gravado no arquivo de deploy.

Antes de ligar o bot, deposite USDC de teste na exchange pela carteira keeper.

Rode os dois sob um gerenciador de processos (systemd, pm2) que os reinicie, com o motor
atrás de um proxy HTTPS. Só um processo pode abrir o arquivo do banco por vez. Acompanhe
`GET /health` (campo `ok` e a lista `warnings`) e `GET /metrics`. Detalhes no
`engine/README.md`, seção "Running on testnet".

## 5. Tela

```bash
cd web
npm install
cp .env.testnet.example .env.testnet   # preencha
npm run build:testnet                   # gera web/dist
```

Preencha `VITE_ENGINE_URL` (URL pública do motor), `VITE_RPC_URL`,
`VITE_EXCHANGE_ADDRESS` e `VITE_USDC_ADDRESS` (do arquivo de deploy). Hospede o conteúdo
de `web/dist`.

## 6. Primeiro teste, com duas carteiras

1. Conecte, troque para a Arbitrum Sepolia e deposite USDC de teste nas duas.
2. Carteira A: ordem de venda no preço do índice. Ela deve aparecer no livro.
3. Carteira B: ordem de compra no mesmo preço. Deve casar, sair de "Em liquidação" para
   executada e aparecer em "Negócios recentes"; as duas posições aparecem.
4. Cancele uma ordem aberta pelo botão normal e outra pelo botão on-chain.
5. Feche as posições e saque.
6. Reinicie o motor com ordens no livro e confira que elas voltam.

## O que observar na primeira semana

Estes pontos só podem ser medidos na rede real:

- **Gás por negociação.** O piso (800 mil por negociação com 2 mercados) foi medido com
  simuladores. Compare com o gás usado de verdade em `settleMatches`.
- **Leitura de eventos.** Erros ou lentidão do provedor em `eth_getLogs` aparecem nos logs
  e em `/metrics`.
- **Preços parados.** Preços de testnet da Chainlink atrasam; o mercado é suspenso
  sozinho e volta sozinho. Ajuste `*_MAX_STALENESS` se a suspensão for frequente demais.
- **Saldo do operador e do keeper.** `/health` avisa quando o do operador fica baixo.
- **Posições acumuladas pelo keeper.** Ele assume o que liquida e ninguém as desfaz
  automaticamente.

## Antes de pensar em mainnet

Auditoria externa, trava de tempo nos poderes do administrador (trocar o oráculo equivale
a definir preços), mecanismo para perdas que o fundo de seguro não cobre, modo de
liquidação de emergência e revisão jurídica. As listas completas estão nos READMEs de
`contracts/` e `engine/`.

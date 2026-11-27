# Foxy

Exchange de futuros perpétuos não custodial (MVP). O usuário assina ordens na própria
carteira, um motor fora da blockchain casa as ordens e um contrato confere as duas
assinaturas, aplica as regras de margem e movimenta os saldos.

> **Sem auditoria. Não use com dinheiro real.** O código foi escrito e revisado por
> agentes de IA e nunca rodou numa rede pública.

Os scripts Python e os gráficos HTML na raiz são anteriores à exchange e não têm relação
com ela.

## Sumário

- [O que tem no repositório](#o-que-tem-no-repositório)
- [Subir na sua máquina](#subir-na-sua-máquina)
- [Usar com a MetaMask](#usar-com-a-metamask)
- [Só a tela, sem nada por trás](#só-a-tela-sem-nada-por-trás)
- [Testes](#testes)
- [Problemas comuns](#problemas-comuns)
- [Arquitetura](#arquitetura)
- [Arquitetura mínima para rodar de verdade](#arquitetura-mínima-para-rodar-de-verdade)
- [O que falta para produção](#o-que-falta-para-produção)

## O que tem no repositório

| Pasta | O que é | Tecnologia |
|---|---|---|
| `contracts/` | Contrato `Exchange` (custódia de USDC, margem, liquidação das negociações, funding, liquidações), adaptador do oráculo Chainlink, scripts de deploy | Solidity 0.8.26, Hardhat |
| `engine/` | Motor: livro de ofertas, casamento de ordens, envio dos lotes ao contrato, API REST e WebSocket. Inclui o *keeper*, o bot de liquidação e de funding | TypeScript, Node 22, SQLite |
| `web/` | Tela de trading | React, Vite, wagmi |
| `shared/` | ABI e tipos de assinatura usados pelo motor e pela tela | TypeScript |
| `docs/SPEC.md` | Regras do protocolo e formato da API | |
| `docs/TESTNET.md` | Passo a passo do deploy na Arbitrum Sepolia | |

Cada pasta tem um README próprio (em inglês) com detalhes e limitações conhecidas.

## Subir na sua máquina

### Requisitos

- **Node.js 22.13 ou mais recente** (`node --version`). O motor usa o SQLite embutido do
  Node, que não existe em versões anteriores.
- **Git.**
- **Navegador com MetaMask**, para usar a tela com carteira.
- Cerca de 1,5 GB livres para as dependências.

Foi testado apenas em Linux. Em macOS deve funcionar igual. No Windows, prefira o Git Bash
ou o WSL, onde os comandos abaixo funcionam como estão; no PowerShell, troque `cp` por
`copy` e, se a sua versão não aceitar `&&`, rode os comandos um por linha.

### 1. Baixar e instalar

```bash
git clone https://github.com/cauansousa/Baldwin.git
cd Baldwin

cd contracts && npm install && cd ..
cd engine    && npm install && cd ..
cd web       && npm install && cd ..
```

### 2. Rodar, em quatro terminais

Deixe cada um aberto. A ordem importa.

**Terminal 1 — blockchain local**

```bash
cd contracts
npm run node
```

Sobe uma blockchain de teste em `http://127.0.0.1:8545` (chain id 31337) e imprime 20
contas com 10.000 ETH de mentira e suas chaves privadas. Essas chaves são públicas e
iguais para todo mundo: servem só aqui.

**Terminal 2 — deploy dos contratos**

```bash
cd contracts
npm run deploy:local
```

Publica um USDC de teste, um oráculo de teste e a exchange, cria os mercados BTC-USD e
ETH-USD, deposita 1.000.000 de USDC de teste nas cinco primeiras contas e grava os
endereços em `contracts/deployments/localhost.json`. Roda uma vez e termina.

**Terminal 2 (o mesmo) — motor**

```bash
cd ../engine
cp .env.example .env
npm start
```

O arquivo `.env.example` já vem pronto para a blockchain local. O motor sobe em
`http://127.0.0.1:8080`. Para conferir: abra `http://127.0.0.1:8080/health` e veja
`"ok": true`.

**Terminal 3 — tela**

```bash
cd web
npm run dev
```

Abra `http://localhost:5173`. A tela lê os endereços dos contratos direto do arquivo de
deploy, sem configuração.

**Terminal 4 — bot de liquidação (opcional)**

```bash
cd engine
npm run keeper
```

Sem ele ninguém liquida contas nem cobra funding. Para testar ordens e posições não faz
falta. Ele avisa que não tem colateral depositado; para liquidar de verdade, deposite USDC
na exchange com a conta nº 1.

### 3. Conferir que está tudo ligado

Com os terminais 1 a 3 rodando:

```bash
cd engine
npx tsx scripts/e2e-local.ts
```

O script deposita com duas contas, envia duas ordens que se cruzam e confere as posições
no contrato. Deve terminar com `E2E PASSED`, e a tela passa a mostrar uma oferta no livro
e um negócio recente.

## Usar com a MetaMask

1. **Adicionar a rede local.** Na MetaMask: adicionar rede manualmente, com nome
   `Hardhat local`, URL do RPC `http://127.0.0.1:8545`, ID da cadeia `31337` e símbolo
   `ETH`.
2. **Importar duas contas de teste.** No terminal 1, copie as chaves privadas das contas
   **nº 2 e nº 3** (`Account #2` e `Account #3`) e importe cada uma na MetaMask. Não use as
   contas nº 0 e nº 1: são o operador do motor e o bot.
3. **Conectar** na tela e, se pedir, trocar para a rede local.
4. **Depositar.** As contas já têm USDC de teste; se precisar de mais, há um botão para
   emitir. Em "Depositar", aprove e deposite.
5. **Negociar.** Com a conta nº 2, envie uma venda no preço do índice. Troque para a conta
   nº 3 e envie uma compra no mesmo preço. A ordem casa, fica "Em liquidação" por um
   instante e vira posição nas duas contas.

Nunca importe essas chaves numa carteira que você usa com dinheiro de verdade, nem mande
fundos reais para esses endereços.

## Só a tela, sem nada por trás

Para ver a interface com dados falsos, sem blockchain, motor nem carteira:

```bash
cd web
npm run dev:mock
```

Aparece o selo "SIMULADO" ao lado do nome.

## Testes

```bash
cd contracts && npx hardhat test        # cerca de 1 minuto
cd engine    && npm test && npm run typecheck
cd web       && npm test && npm run typecheck && npm run build
```

Há também um teste de carga do motor (`engine/scripts/soak-local.ts`); as instruções estão
no cabeçalho do arquivo.

## Problemas comuns

| Sintoma | Causa e solução |
|---|---|
| O motor não sobe e reclama do arquivo de deploy | Faltou o `npm run deploy:local`, ou a blockchain local não está rodando. |
| Reiniciei a blockchain local e nada mais funciona | Ela começa do zero a cada vez. Rode o deploy de novo, apague a pasta `engine/data` e reinicie o motor. |
| A MetaMask trava a transação ou reclama de *nonce* | Depois de reiniciar a blockchain local, limpe os dados de atividade da conta nas configurações avançadas da MetaMask. |
| A tela diz que o motor está inacessível | O motor não está rodando, ou não está na porta 8080. |
| `node:sqlite` não encontrado | A versão do Node é anterior à 22.13. |
| Ordem recusada por "preço fora da faixa" | Toda negociação precisa ficar a no máximo 5% do preço do índice. |
| Porta 8545, 8080 ou 5173 ocupada | Outro programa está usando; feche-o ou, no caso do motor, mude `PORT` no `engine/.env`. |

## Arquitetura

```
   Navegador
   ┌────────────────────────┐
   │ Tela (web/)            │
   │ + carteira (MetaMask)  │
   └───┬────────────────┬───┘
       │ ordens         │ depósito, saque,
       │ assinadas      │ cancelamento on-chain,
       │ (REST/WS)      │ leituras
       ▼                │
   ┌──────────────┐     │        ┌─────────────────┐
   │ Motor        │     │        │ Keeper (bot)    │
   │ (engine/)    │     │        │ liquidações,    │
   │ livro, casa  │     │        │ funding         │
   │ ordens,      │     │        └────────┬────────┘
   │ SQLite       │     │                 │
   └──────┬───────┘     │                 │
          │ lotes de    │                 │
          │ negociações │                 │
          ▼             ▼                 ▼
   ┌──────────────────────────────────────────────┐
   │ Blockchain                                   │
   │  Exchange ── oráculo de preços ── USDC       │
   └──────────────────────────────────────────────┘
```

**Caminho de uma ordem**

1. O usuário preenche a ordem e assina na carteira (EIP-712). Nada vai para a blockchain
   nesse momento e não custa gás.
2. A tela envia a ordem assinada ao motor.
3. O motor confere a assinatura e a margem, coloca no livro e casa com ordens opostas por
   prioridade de preço e de chegada.
4. O motor, como operador, envia o lote de negociações ao contrato.
5. O contrato confere as duas assinaturas, o preço contra o oráculo e a margem de cada
   lado, e só então movimenta os saldos. Uma negociação inválida falha sozinha, sem
   derrubar o lote.

**Quem pode o quê**

- **O usuário** deposita, saca e cancela direto no contrato, sem depender de ninguém.
- **O operador** (o motor) escolhe a ordem de execução e pode ignorar ordens, mas não
  movimenta fundos sem duas assinaturas válidas.
- **O administrador** cria mercados, muda parâmetros e pode trocar o oráculo. É o papel
  mais poderoso e deve ficar num multisig atrás de uma trava de tempo.
- **O guardião** só pausa.
- **Qualquer pessoa** pode liquidar uma conta sem margem e depositar no fundo de seguro.

As regras completas (margem, funding, liquidação, pausa) estão em `docs/SPEC.md`.

## Arquitetura mínima para rodar de verdade

O que roda na sua máquina é tudo num computador só. Para uma testnet pública, e depois
produção, o mínimo razoável é:

```
                      usuários
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
   Site estático (CDN)          Proxy HTTPS (Caddy ou Nginx)
   arquivos de web/dist         limite de requisições, TLS
                                        │
                                        ▼
   ┌────────────────── servidor A ──────────────────┐
   │ Motor (1 processo)   +  disco persistente      │
   │                         (arquivo SQLite)       │
   └───────────────────────┬────────────────────────┘
                           │
   ┌────── servidor B ─────┼────────────────────────┐
   │ Keeper (1 processo)   │                        │
   └───────────────────────┼────────────────────────┘
                           ▼
              Provedor de RPC (principal + reserva)
                           │
                           ▼
   Blockchain: Exchange, ChainlinkOracle, Timelock
                           ▲
                           │ agenda e executa
                    Multisig (Safe)

   Ao lado de tudo: monitoramento (Prometheus + alertas),
   cópia de segurança do SQLite, cofre de segredos.
```

| Peça | Mínimo | Por quê |
|---|---|---|
| Tela | Hospedagem estática com HTTPS | São só arquivos; não precisa de servidor. |
| Motor | Uma máquina pequena (2 vCPU, 4 GB) com disco persistente | O livro e as negociações pendentes ficam num arquivo SQLite. Só um processo pode abri-lo. |
| Keeper | Outra máquina, ou ao menos outro processo com outra chave | Se o motor cair, as liquidações precisam continuar. |
| RPC | Provedor pago, com um segundo de reserva | O motor e o bot dependem dele para tudo; provedores que respondem com atraso causam erros. |
| Chaves | Operador e keeper em cofre de segredos; nenhuma delas guarda fundos de usuários | Um vazamento da chave do operador permite censurar e reordenar, não sacar. |
| Administração | Multisig 2-de-3 com carteiras físicas, atrás de trava de tempo; guardião separado para pausar | O administrador pode trocar o oráculo, o que equivale a definir preços. |
| Monitoramento | Coleta de `/metrics`, alerta em `/health`, saldo do operador, dívida registrada | Liquidação não espera horário comercial. |
| Cópias | Cópia periódica do arquivo SQLite | A perda do arquivo apaga o livro; os saldos estão na blockchain e não se perdem. |

**Para produção, além disso:** chave do operador em HSM ou KMS, servidor reserva pronto
para assumir (um de cada vez, nunca dois motores ao mesmo tempo), um indexador com banco
de dados para histórico de negócios e de funding, proteção contra ataques de negação de
serviço e plantão com plano de resposta a incidentes.

O passo a passo do primeiro deploy público está em `docs/TESTNET.md`. Há um `Dockerfile` e
um `docker-compose.testnet.yml` em `engine/`, mas **nunca foram construídos nem testados**.

## O que falta para produção

Em ordem de peso:

1. **Auditoria externa.** Revisões automáticas acharam defeitos graves em todas as rodadas;
   há mais a achar.
2. **Um responsável técnico humano** que tenha lido e entenda os contratos.
3. **Enquadramento jurídico.** Perpétuo alavancado é derivativo.
4. **Semanas de testnet** com usuários e market makers reais. Nada aqui rodou numa rede
   pública.
5. **Liquidez.** Sem market makers o livro fica vazio.

Lacunas conhecidas de produto:

- Perda maior que o fundo de seguro vira dívida registrada; não há divisão de perdas.
- Se o operador sumir, o usuário não consegue fechar posição sozinho.
- Um único operador e um único processo de motor.
- Em mercado com pouca negociação, quem negocia sozinho ainda influencia o funding.
- Carteiras de contrato (Safe, contas inteligentes) não conseguem assinar ordens.
- Não há histórico de funding nem de lucro realizado por conta.

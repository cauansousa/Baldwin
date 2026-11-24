// Shared, dependency-free protocol definitions. Mirrors
// contracts/src/interfaces/IExchange.sol — change both together.
// Consumers: `parseAbi(EXCHANGE_ABI)` from viem.

export const EIP712_DOMAIN_NAME = "Baldwin";
export const EIP712_DOMAIN_VERSION = "1";

export const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "marketId", type: "uint32" },
    { name: "isBuy", type: "bool" },
    { name: "reduceOnly", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "limitPrice", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/** Off-chain cancel request, signed by the trader and sent to the engine only. */
export const CANCEL_TYPES = {
  Cancel: [
    { name: "trader", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const WAD = 10n ** 18n;
export const USDC_DECIMALS = 6;
export const BPS = 10_000n;

export interface Order {
  trader: `0x${string}`;
  marketId: number;
  isBuy: boolean;
  reduceOnly: boolean;
  size: bigint;
  limitPrice: bigint;
  nonce: bigint;
  expiry: bigint;
}

export const EXCHANGE_ABI = [
  "struct Order { address trader; uint32 marketId; bool isBuy; bool reduceOnly; uint256 size; uint256 limitPrice; uint256 nonce; uint64 expiry; }",
  "struct Match { Order maker; bytes makerSig; Order taker; bytes takerSig; uint256 fillSize; }",
  "struct Market { bool active; uint16 initialMarginBps; uint16 maintenanceMarginBps; uint16 makerFeeBps; uint16 takerFeeBps; uint16 liquidationPenaltyBps; uint256 maxOpenInterest; uint256 minOrderSize; string symbol; }",
  "struct Position { int256 size; uint256 entryNotional; int256 lastCumulativeFunding; }",
  "event Deposit(address indexed trader, uint256 amount)",
  "event Withdraw(address indexed trader, uint256 amount)",
  "event MarketAdded(uint32 indexed marketId, string symbol)",
  "event MarketUpdated(uint32 indexed marketId)",
  "event Fill(uint32 indexed marketId, address indexed maker, address indexed taker, bytes32 makerOrderHash, bytes32 takerOrderHash, bool takerIsBuy, uint256 size, uint256 price, uint256 makerFee, uint256 takerFee)",
  "event MatchFailed(uint256 indexed index, bytes32 makerOrderHash, bytes32 takerOrderHash, bytes reason)",
  "event OrderCancelled(address indexed trader, uint256 nonce)",
  "event OrdersCancelledBelow(address indexed trader, uint256 minValidNonce)",
  "event FundingUpdated(uint32 indexed marketId, int256 fundingRateBps, int256 cumulativeFunding, uint256 timestamp)",
  "event Liquidation(uint32 indexed marketId, address indexed trader, address indexed liquidator, int256 size, uint256 price, uint256 penalty, uint256 badDebt)",
  "event InsuranceDeposit(address indexed from, uint256 amount, uint256 badDebtRepaid)",
  "event GuardianUpdated(address indexed guardian)",
  "event OperatorUpdated(address indexed operator, bool allowed)",
  "event Paused(bool paused)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function cancelOrder(uint256 nonce)",
  "function cancelAllOrders(uint256 newMinValidNonce)",
  "function depositInsurance(uint256 amount)",
  "function settleMatches(Match[] matches)",
  "function liquidate(address trader, uint32 marketId, uint256 maxSize)",
  "function updateFunding(uint32 marketId)",
  "function collateralToken() view returns (address)",
  "function marketCount() view returns (uint32)",
  "function getMarket(uint32 marketId) view returns (Market)",
  "function getPosition(address trader, uint32 marketId) view returns (Position)",
  "function balanceOf(address trader) view returns (int256)",
  "function accountValue(address trader) view returns (int256)",
  "function marginRequirement(address trader) view returns (uint256 initial, uint256 maintenance)",
  "function freeCollateral(address trader) view returns (uint256)",
  "function isLiquidatable(address trader) view returns (bool)",
  "function indexPrice(uint32 marketId) view returns (uint256)",
  "function markPrice(uint32 marketId) view returns (uint256)",
  "function markTwap(uint32 marketId) view returns (uint256)",
  "function currentFundingRate(uint32 marketId) view returns (int256)",
  "function guardian() view returns (address)",
  "function oracle() view returns (address)",
  "function cumulativeFunding(uint32 marketId) view returns (int256)",
  "function openInterest(uint32 marketId) view returns (uint256 longs, uint256 shorts)",
  "function insuranceFund() view returns (uint256)",
  "function hashOrder(Order order) view returns (bytes32)",
  "function filledSize(bytes32 orderHash) view returns (uint256)",
  "function isCancelled(address trader, uint256 nonce) view returns (bool)",
  "function minValidNonce(address trader) view returns (uint256)",
  "function maxOrderLifetime() view returns (uint256)",
  "function isOperator(address account) view returns (bool)",
  // Implementation details of Exchange.sol that off-chain code relies on (not in IExchange).
  "function paused() view returns (bool)",
  "function lastFundingTime(uint32 marketId) view returns (uint256)",
  "function maxPriceDeviationBps() view returns (uint256)",
  "function totalBadDebt() view returns (uint256)",
  "function isLiquidatableIn(address trader, uint32 marketId) view returns (bool)",
  "function MATCH_GAS_BASE() view returns (uint256)",
  "function MATCH_GAS_PER_MARKET() view returns (uint256)",
  "error InsufficientMargin(address trader)",
  "error NegativeAccountValue(address trader)",
  "error ReduceOnlyViolated(address trader)",
  "error PriceOutOfBand(uint256 price, uint256 index)",
  "error StalePrice(uint32 marketId)",
  "error OnlyReducingAllowed()",
  "error OpenInterestCapExceeded()",
  "error FillTooSmall()",
  "error InsufficientGas()",
  "error InvalidExpiry()",
  "error OrderIsCancelled()",
  "error OrderExpired()",
  "error NonceNotIncreased()",
  "error NonceTooHigh()",
  // Raised by ChainlinkOracle and bubbled through the Exchange.
  "error SequencerDown()",
  "error SequencerGracePeriodNotOver()",
  "error FeedStale(uint32 marketId, uint256 updatedAt)",
  "error InvalidAnswer(uint32 marketId)",
  "error FeedNotSet(uint32 marketId)",
] as const;

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function mint(address to, uint256 amount)",
] as const;

/** Written by contracts/scripts/deploy.ts to contracts/deployments/<network>.json */
export interface Deployment {
  chainId: number;
  exchange: `0x${string}`;
  usdc: `0x${string}`;
  oracle: `0x${string}`;
  markets: { marketId: number; symbol: string }[];
  /** Block the Exchange was created in; where event readers start. Absent on local deployments. */
  deploymentBlock?: number;
}

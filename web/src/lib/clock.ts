// The engine's clock (GET /health `time`: the later of its host clock and chain
// time) is the one order expiries and nonces are judged by. Orders are dated
// from it when a recent reading exists, and from the device clock otherwise.

/** A reading older than this is not trusted any more (the engine may be unreachable). */
export const ENGINE_TIME_MAX_AGE_MS = 5 * 60_000;

export interface EngineClock {
  /** Record a reading: the engine's unix seconds, observed at device time `deviceNowMs`. */
  sync(engineTimeSec: number, deviceNowMs?: number): void;
  /** Current time in ms: engine-based when a fresh reading exists, device clock otherwise. */
  nowMs(deviceNowMs?: number): number;
  /** True when nowMs() is currently engine-based. */
  synced(deviceNowMs?: number): boolean;
}

export function createEngineClock(): EngineClock {
  let offsetMs = 0;
  let syncedAt: number | undefined;
  const fresh = (deviceNowMs: number) => syncedAt !== undefined && Math.abs(deviceNowMs - syncedAt) <= ENGINE_TIME_MAX_AGE_MS;
  return {
    sync(engineTimeSec, deviceNowMs = Date.now()) {
      if (!Number.isFinite(engineTimeSec) || engineTimeSec <= 0) return;
      offsetMs = engineTimeSec * 1000 - deviceNowMs;
      syncedAt = deviceNowMs;
    },
    nowMs(deviceNowMs = Date.now()) {
      return fresh(deviceNowMs) ? deviceNowMs + offsetMs : deviceNowMs;
    },
    synced: (deviceNowMs = Date.now()) => fresh(deviceNowMs),
  };
}

/** The app-wide clock, synchronised by the /health poll. */
export const engineClock = createEngineClock();

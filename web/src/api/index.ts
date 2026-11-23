import { config, MOCK } from "../config";
import { createHttpEngine } from "./http";
import type { EngineApi } from "./types";

// `import.meta.env.DEV` is repeated here (MOCK already implies it) so the
// bundler can statically drop the mock import from production builds.
export const engine: EngineApi =
  import.meta.env.DEV && MOCK ? (await import("../mock/engine")).mockEngine : createHttpEngine(config.engineUrl);

export type * from "./types";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const deploymentsDir = path.resolve(repoRoot, "contracts/deployments");

/** Every readable contracts/deployments/<network>.json (localhost, arbitrumSepolia, ...). */
function readDeployments(): unknown[] {
  if (!existsSync(deploymentsDir)) return [];
  const out: unknown[] = [];
  for (const file of readdirSync(deploymentsDir).sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(path.join(deploymentsDir, file), "utf8")));
    } catch (err) {
      console.warn(`[foxy] could not parse ${file}:`, err);
    }
  }
  return out;
}

/**
 * Dev-server only: exposes the deployments written by `contracts/scripts/deploy.ts`
 * as `__DEV_DEPLOYMENTS__`; the app picks the one whose chainId matches
 * VITE_CHAIN_ID, so addresses do not have to be typed into `.env`. Restarts the
 * dev server when a deployment file is (re)written. Production builds always
 * get `[]` and must take addresses from VITE_* env.
 */
function devDeployments(): Plugin {
  return {
    name: "foxy-dev-deployments",
    config(_config, { command }) {
      const deployments = command === "serve" ? readDeployments() : [];
      if (deployments.length > 0) console.log(`[foxy] found ${deployments.length} deployment file(s) in ${deploymentsDir}`);
      return { define: { __DEV_DEPLOYMENTS__: JSON.stringify(deployments) } };
    },
    configureServer(server) {
      server.watcher.add(deploymentsDir);
      const onChange = (file: string) => {
        if (path.dirname(path.resolve(file)) === deploymentsDir && file.endsWith(".json")) void server.restart();
      };
      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
      server.watcher.on("unlink", onChange);
    },
  };
}

export default defineConfig({
  plugins: [react(), devDeployments()],
  resolve: {
    alias: { "@shared": path.resolve(repoRoot, "shared/src/index.ts") },
  },
  server: {
    port: 5173,
    // `shared/` lives outside the web root.
    fs: { allow: [here, path.resolve(repoRoot, "shared")] },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

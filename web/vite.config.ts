import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const localDeploymentFile = path.resolve(repoRoot, "contracts/deployments/localhost.json");

/** Reads contracts/deployments/localhost.json, or null when absent/unreadable. */
function readLocalDeployment(): unknown {
  if (!existsSync(localDeploymentFile)) return null;
  try {
    return JSON.parse(readFileSync(localDeploymentFile, "utf8"));
  } catch (err) {
    console.warn(`[baldwin] could not parse ${localDeploymentFile}:`, err);
    return null;
  }
}

/**
 * Dev-server only: exposes the local deployment written by
 * `contracts/scripts/deploy.ts` as `__LOCAL_DEPLOYMENT__` so the addresses do
 * not have to be typed into `.env`. Restarts the dev server when the file is
 * (re)written. Production builds always get `null` and must use VITE_* env.
 */
function localDeployment(): Plugin {
  return {
    name: "baldwin-local-deployment",
    config(_config, { command }) {
      const deployment = command === "serve" ? readLocalDeployment() : null;
      if (deployment) console.log(`[baldwin] using addresses from ${localDeploymentFile}`);
      return { define: { __LOCAL_DEPLOYMENT__: JSON.stringify(deployment) } };
    },
    configureServer(server) {
      server.watcher.add(localDeploymentFile);
      const onChange = (file: string) => {
        if (path.resolve(file) === localDeploymentFile) void server.restart();
      };
      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
      server.watcher.on("unlink", onChange);
    },
  };
}

export default defineConfig({
  plugins: [react(), localDeployment()],
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

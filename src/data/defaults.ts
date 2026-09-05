import { commands } from "../bindings";
import type { PlannerConfig } from "../bindings";

let defaultConfig: PlannerConfig | undefined;

/**
 * Fetch the default project from the Rust core. The store clones it for new
 * projects, so this must resolve before the store module is imported.
 */
export async function loadDefaultConfig(): Promise<void> {
  const result = await commands.defaultConfig();
  defaultConfig = result;
}

export function getDefaultConfig(): PlannerConfig {
  if (!defaultConfig) {
    throw new Error("default config requested before loadDefaultConfig() resolved");
  }
  return structuredClone(defaultConfig);
}

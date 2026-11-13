/**
 * A project's `migrations/` applied to the database of a run, the way `sproutboat d1 migrations apply --local` would,
 * for the starters whose schema is a migration and not something the Worker creates (templates/api-d1).
 *
 * A standalone binary keeps `<SB_DATA_DIR>/d1/<BINDING>.sqlite`, which is where `localDatabasePath` points when given
 * the data directory, so the same code that `sproutboat d1` uses prepares it before the binary starts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SproutboatConfig } from "../../../src/config";
import { applyMigrations, d1Bindings, localDatabasePath, localRunner } from "../../../src/d1-cli";

export const migrationsDir = (projectDir: string): string => join(projectDir, "migrations");

export async function applyProjectMigrations(
  projectDir: string,
  config: SproutboatConfig,
  dataDir: string,
): Promise<void> {
  const dir = migrationsDir(projectDir);
  if (!existsSync(dir)) return;
  for (const binding of d1Bindings(config)) {
    const runner = localRunner(localDatabasePath(projectDir, binding, dataDir));
    await applyMigrations(runner, dir, { log() {}, note() {}, interactive: false, confirm: async () => true });
  }
}

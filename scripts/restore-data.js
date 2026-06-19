import { copyFile, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const dataFile = join(projectRoot, "data", "fish-rubbing.json");
const backupFile = join(projectRoot, "data", "fish-rubbing.json.bak-test");

async function main() {
  try {
    await stat(backupFile);
    await copyFile(backupFile, dataFile);
    await rm(backupFile, { force: true });
    console.log(`[posttest] Restored data file from backup: ${backupFile} -> ${dataFile}`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("[posttest] No backup found, nothing to restore.");
    } else {
      console.error("[posttest] Failed to restore data file:", err.message);
      process.exit(1);
    }
  }
}

main();

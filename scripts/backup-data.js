import { copyFile, stat, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const dataFile = join(projectRoot, "data", "fish-rubbing.json");
const backupFile = join(projectRoot, "data", "fish-rubbing.json.bak-test");

async function main() {
  try {
    await stat(dataFile);
    await mkdir(dirname(backupFile), { recursive: true });
    await copyFile(dataFile, backupFile);
    console.log(`[pretest] Backed up data file: ${dataFile} -> ${backupFile}`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("[pretest] No data file found to back up, skipping.");
    } else {
      console.error("[pretest] Failed to back up data file:", err.message);
      process.exit(1);
    }
  }
}

main();

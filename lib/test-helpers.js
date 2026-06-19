import { fork } from "node:child_process";
import { mkdir, rm, writeFile, readFile, copyFile, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const tmpRoot = join(projectRoot, ".test-tmp");
const dataDir = join(projectRoot, "data");
const dataFile = join(dataDir, "fish-rubbing.json");
const backupFile = join(dataDir, "fish-rubbing.json.bak-test");

export const paths = {
  projectRoot,
  tmpRoot,
  tmpDir: tmpRoot,
  dataDir,
  dataFile,
  backupFile,
  serverFile: join(projectRoot, "server.js")
};

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function makeHash(str) {
  return createHash("sha1").update(str).digest("hex").slice(0, 12);
}

export function randomPort() {
  return 13000 + Math.floor(Math.random() * 20000);
}

export async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

export async function backupDataFile() {
  if (await fileExists(dataFile)) {
    await copyFile(dataFile, backupFile);
    return true;
  }
  return false;
}

export async function restoreDataFile() {
  if (await fileExists(backupFile)) {
    await copyFile(backupFile, dataFile);
    await rm(backupFile, { force: true });
    return true;
  }
  return false;
}

export async function isDataFileUnchanged(beforeHash) {
  if (!(await fileExists(dataFile))) return false;
  const content = await readFile(dataFile, "utf8");
  return makeHash(content) === beforeHash;
}

export async function hashDataFile() {
  if (!(await fileExists(dataFile))) return null;
  return makeHash(await readFile(dataFile, "utf8"));
}

async function ensureTmpRoot() {
  await mkdir(tmpRoot, { recursive: true });
}

export function createTestContext(nameOrUrl) {
  let scopeName = nameOrUrl;
  if (typeof nameOrUrl === "string" && nameOrUrl.startsWith("file://")) {
    scopeName = basename(nameOrUrl, ".test.js").replace(/\.test$/, "");
  }
  const scopeDir = join(tmpRoot, scopeName);

  function tmpFilePath(prefix = "test") {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    return join(scopeDir, `${prefix}-${ts}-${rand}.json`);
  }

  async function ensureScopeDir() {
    await mkdir(scopeDir, { recursive: true });
  }

  async function cleanScopeDir() {
    await rm(scopeDir, { recursive: true, force: true });
    await mkdir(scopeDir, { recursive: true });
  }

  async function copyDataFileToScope(prefix = "test") {
    await ensureScopeDir();
    const target = tmpFilePath(prefix);
    if (await fileExists(dataFile)) {
      await copyFile(dataFile, target);
    }
    return target;
  }

  async function seedTmpFile(seedData, prefix = "test") {
    await ensureScopeDir();
    const target = tmpFilePath(prefix);
    await writeJson(target, seedData);
    return target;
  }

  async function startServer(dbPath, customSeed = null, port = null) {
    await ensureTmpRoot();
    await ensureScopeDir();
    if (customSeed) {
      await writeJson(dbPath, deepClone(customSeed));
    }
    const serverPort = port || randomPort();
    return new Promise((resolve, reject) => {
      const child = fork(paths.serverFile, [], {
        env: {
          ...process.env,
          NO_LISTEN: "",
          DB_PATH: dbPath,
          PORT: String(serverPort)
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        detached: false
      });
      let ready = false;
      let outBuf = "";
      let errBuf = "";
      const checkReady = (msg) => {
        if (msg.includes("Fish rubbing studio app listening") && !ready) {
          ready = true;
          resolve({
            port: serverPort,
            url: `http://localhost:${serverPort}`,
            child,
            dbPath
          });
        }
      };
      child.stdout.on("data", (d) => { outBuf += d.toString(); checkReady(outBuf); });
      child.stderr.on("data", (d) => { errBuf += d.toString(); checkReady(errBuf); });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (!ready) reject(new Error(`server exited with code ${code}. stdout=${outBuf} stderr=${errBuf}`));
      });
      setTimeout(() => {
        if (!ready) { child.kill("SIGKILL"); reject(new Error(`timeout. stdout=${outBuf} stderr=${errBuf}`)); }
      }, 15000);
    });
  }

  async function stopServer(ctx) {
    if (ctx && ctx.child) {
      ctx.child.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 200));
      try { ctx.child.kill("SIGKILL"); } catch (e) {}
    }
  }

  async function request(url, path, options = {}) {
    const fullUrl = url + path;
    const res = await fetch(fullUrl, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch (e) {}
    return { status: res.status, body, headers: res.headers, text };
  }

  return {
    scopeName,
    scopeDir,
    tmpFilePath,
    ensureScopeDir,
    cleanScopeDir,
    copyDataFileToScope,
    seedTmpFile,
    startServer,
    stopServer,
    request,
    writeJson,
    readJson,
    fileExists,
    deepClone,
    randomPort,
    makeHash
  };
}

export async function cleanTmpRoot() {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
}

export async function ensureTmpRootDir() {
  await mkdir(tmpRoot, { recursive: true });
}

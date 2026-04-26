import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const WORKSPACE_DIR = path.join(ROOT, "workspace");
const DOCUMENTS_SAVE_DIR = path.join(ROOT, "saved-python-files");
const RUNTIME_DIR = path.join(ROOT, ".runtime");
const DIST_DIR = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT || 5173);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

async function ensureWorkspace() {
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  await fs.mkdir(DOCUMENTS_SAVE_DIR, { recursive: true });
  await fs.rm(RUNTIME_DIR, { recursive: true, force: true });
  await fs.mkdir(RUNTIME_DIR, { recursive: true });

  const mainPath = path.join(WORKSPACE_DIR, "main.py");
  if (!fsSync.existsSync(mainPath)) {
    await fs.writeFile(
      mainPath,
      [
        "project_name = \"Ali's Code Editor\"",
        "",
        "def greet(name):",
        "    return f\"Hello, {name}!\"",
        "",
        "print(project_name)",
        "print(greet(\"Python\"))",
        "",
        "for number in range(1, 4):",
        "    print(f\"Line {number} is running\")",
        ""
      ].join("\n"),
      "utf8"
    );
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizePythonPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("A Python file path is required.");
  }

  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");

  if (!normalized.endsWith(".py")) {
    throw new Error("This editor only opens and runs .py files.");
  }

  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid Python file path.");
  }

  return normalized;
}

function safePathInside(root, relativePath) {
  const normalized = normalizePythonPath(relativePath);
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("That file is outside the editor workspace.");
  }

  return {
    absolute,
    relative: relative.replace(/\\/g, "/")
  };
}

async function walkPythonFiles(dir = WORKSPACE_DIR, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relative = path.join(base, entry.name);
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkPythonFiles(absolute, relative)));
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function findPython() {
  const candidates = [
    { cmd: "python", args: [] },
    { cmd: "py", args: ["-3"] },
    { cmd: "python3", args: [] }
  ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.cmd, [...candidate.args, "--version"], {
      encoding: "utf8",
      windowsHide: true
    });

    if (result.status === 0) return candidate;
  }

  return null;
}

function runPython(filePath, cwd, debug) {
  return new Promise((resolve) => {
    const python = findPython();

    if (!python) {
      resolve({
        code: 127,
        stdout: "",
        stderr: "Python was not found on PATH. Install Python or add it to PATH to run scripts."
      });
      return;
    }

    const args = debug
      ? [...python.args, "-m", "trace", "--trace", filePath]
      : [...python.args, filePath];

    const child = spawn(python.cmd, args, {
      cwd,
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      stderr += "\nProcess stopped after 10 seconds.";
    }, 10000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function writeRuntimeProject(files, entryPath) {
  const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runDir = path.join(RUNTIME_DIR, runId);
  await fs.mkdir(runDir, { recursive: true });

  for (const file of files) {
    const relative = normalizePythonPath(file.path);
    const target = path.resolve(runDir, relative);
    const inside = path.relative(runDir, target);

    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new Error("Invalid file in opened folder.");
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, String(file.content || ""), "utf8");
  }

  const entry = safePathInside(runDir, entryPath);
  return { runDir, entryPath: entry.absolute };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/workspace-files") {
      const files = await walkPythonFiles();
      sendJson(res, 200, { files });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace-file") {
      const { absolute, relative } = safePathInside(WORKSPACE_DIR, url.searchParams.get("path"));
      const content = await fs.readFile(absolute, "utf8");
      sendJson(res, 200, { path: relative, content });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace-file") {
      const body = await readJson(req);
      const { absolute, relative } = safePathInside(WORKSPACE_DIR, body.path);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, String(body.content || ""), "utf8");
      sendJson(res, 200, { path: relative, saved: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/documents-file") {
      const body = await readJson(req);
      const { absolute, relative } = safePathInside(DOCUMENTS_SAVE_DIR, body.path);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, String(body.content || ""), "utf8");
      sendJson(res, 200, {
        path: relative,
        absolutePath: absolute,
        saved: true
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = await readJson(req);
      const debug = Boolean(body.debug);

      if (body.workspacePath) {
        const { absolute, relative } = safePathInside(WORKSPACE_DIR, body.workspacePath);
        await fs.writeFile(absolute, String(body.content || ""), "utf8");
        const result = await runPython(absolute, path.dirname(absolute), debug);
        sendJson(res, 200, { ...result, path: relative });
        return;
      }

      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) {
        throw new Error("No Python files were provided to run.");
      }

      const entryPath = normalizePythonPath(body.entryPath);
      const runtime = await writeRuntimeProject(files, entryPath);
      const result = await runPython(runtime.entryPath, runtime.runDir, debug);
      sendJson(res, 200, { ...result, path: entryPath });
      return;
    }

    sendJson(res, 404, { error: "Unknown API route." });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function serveProduction(req, res) {
  const requestPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const absolute = path.resolve(DIST_DIR, relative);
  const inside = path.relative(DIST_DIR, absolute);

  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(absolute);
    const type = MIME_TYPES[path.extname(absolute)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch {
    const fallback = await fs.readFile(path.join(DIST_DIR, "index.html"));
    sendText(res, 200, fallback, "text/html; charset=utf-8");
  }
}

async function start() {
  await ensureWorkspace();

  let vite = null;
  if (!IS_PRODUCTION) {
    const { createServer } = await import("vite");
    vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      handleApi(req, res);
      return;
    }

    if (vite) {
      vite.middlewares(req, res, () => sendText(res, 404, "Not found"));
      return;
    }

    serveProduction(req, res);
  });

  server.listen(PORT, () => {
    console.log(`Ali's Code Editor running at http://localhost:${PORT}/`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});

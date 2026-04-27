import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const WORKSPACE_DIR = path.join(ROOT, "workspace");
const DOCUMENTS_SAVE_DIR = path.join(ROOT, "saved-javascript-files");
const DIST_DIR = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT || 5173);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

async function ensureWorkspace() {
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  await fs.mkdir(DOCUMENTS_SAVE_DIR, { recursive: true });

  const mainPath = path.join(WORKSPACE_DIR, "main.js");
  if (!fsSync.existsSync(mainPath)) {
    await fs.writeFile(
      mainPath,
      [
        "const projectName = \"Ali's Code Editor\";",
        "",
        "function greet(name) {",
        "  return `Hello, ${name}!`;",
        "}",
        "",
        "console.log(projectName);",
        "console.log(greet(\"JavaScript\"));",
        "",
        "for (let number = 1; number <= 3; number += 1) {",
        "  console.log(`Line ${number} is running`);",
        "}",
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

function normalizeScriptPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("A JavaScript file path is required.");
  }

  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");

  if (!normalized.endsWith(".js")) {
    throw new Error("This editor only opens and saves .js files.");
  }

  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid JavaScript file path.");
  }

  return normalized;
}

function safePathInside(root, relativePath) {
  const normalized = normalizeScriptPath(relativePath);
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

async function walkJavaScriptFiles(dir = WORKSPACE_DIR, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relative = path.join(base, entry.name);
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkJavaScriptFiles(absolute, relative)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/workspace-files") {
      const files = await walkJavaScriptFiles();
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

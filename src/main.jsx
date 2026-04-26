import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const PYTHON_ACCEPT = {
  "text/x-python": [".py"],
  "text/plain": [".py"]
};

const SAMPLE_TERMINAL = "> ready\n> open a .py file or folder, then run it here";

function basename(filePath) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function makeId(prefix) {
  if (crypto.randomUUID) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function isPythonFile(name) {
  return name.toLowerCase().endsWith(".py");
}

function groupDocs(docs) {
  const groups = [];
  const index = new Map();

  for (const doc of docs) {
    if (!index.has(doc.rootId)) {
      index.set(doc.rootId, {
        id: doc.rootId,
        name: doc.rootName,
        origin: doc.origin,
        docs: []
      });
      groups.push(index.get(doc.rootId));
    }

    index.get(doc.rootId).docs.push(doc);
  }

  for (const group of groups) {
    group.docs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  return groups;
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.error || "Request failed.");
  }

  return body;
}

async function readFileHandle(handle) {
  const file = await handle.getFile();

  if (!isPythonFile(file.name)) {
    throw new Error("Only .py files can be opened.");
  }

  return {
    name: file.name,
    content: await file.text()
  };
}

async function collectPythonFilesFromDirectory(directoryHandle, prefix = "") {
  const docs = [];

  for await (const [name, handle] of directoryHandle.entries()) {
    const relative = normalizeRelativePath(`${prefix}${name}`);

    if (handle.kind === "directory") {
      docs.push(...(await collectPythonFilesFromDirectory(handle, `${relative}/`)));
    } else if (handle.kind === "file" && isPythonFile(name)) {
      const file = await handle.getFile();
      docs.push({
        handle,
        name,
        relativePath: relative,
        content: await file.text()
      });
    }
  }

  return docs;
}

function Icon({ name }) {
  if (name === "folder") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6.5h7l2 2h9v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    );
  }

  if (name === "file") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h8l4 4v14H6z" />
        <path d="M14 3v5h5" />
      </svg>
    );
  }

  if (name === "save") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4h12l2 2v14H5z" />
        <path d="M8 4v6h8V4" />
        <path d="M8 20v-6h8v6" />
      </svg>
    );
  }

  if (name === "play") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    );
  }

  if (name === "bug") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 8h8v9a4 4 0 0 1-8 0z" />
        <path d="M9 4l2 3M15 4l-2 3M4 13h4M16 13h4M5 19l3-2M19 19l-3-2" />
      </svg>
    );
  }

  return null;
}

function App() {
  const [docs, setDocs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [terminal, setTerminal] = useState(SAMPLE_TERMINAL);
  const [projectName, setProjectName] = useState("Ali's Python Project");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [isBusy, setIsBusy] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const editorRef = useRef(null);
  const lineNumberRef = useRef(null);

  const activeDoc = docs.find((doc) => doc.id === activeId) || docs[0] || null;
  const groups = useMemo(() => groupDocs(docs), [docs]);
  const lines = activeDoc?.content.split("\n").length || 1;
  const canUseFileSystemAccess =
    typeof window !== "undefined" &&
    "showOpenFilePicker" in window &&
    "showDirectoryPicker" in window;

  useEffect(() => {
    loadWorkspace();
  }, []);

  useEffect(() => {
    document.title = `${projectName || "Untitled"} - Code Editor`;
  }, [projectName]);

  useEffect(() => {
    updateCursor();
  }, [activeDoc?.id]);

  async function loadWorkspace() {
    try {
      const { files } = await requestJson("/api/workspace-files");
      const workspaceDocs = await Promise.all(
        files.map(async (filePath) => {
          const body = await requestJson(`/api/workspace-file?path=${encodeURIComponent(filePath)}`);
          return {
            id: `workspace:${body.path}`,
            origin: "workspace",
            rootId: "workspace",
            rootName: "Workspace",
            name: basename(body.path),
            relativePath: body.path,
            content: body.content,
            dirty: false,
            writable: true
          };
        })
      );

      setDocs(workspaceDocs);
      setActiveId(workspaceDocs[0]?.id || null);
      setTerminal("> workspace loaded\n> Python files only");
    } catch (error) {
      setTerminal(error.message);
    }
  }

  function replaceDoc(id, patch) {
    setDocs((current) =>
      current.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc))
    );
  }

  function addDocs(newDocs) {
    setDocs((current) => {
      const withoutDuplicates = current.filter(
        (doc) => !newDocs.some((newDoc) => newDoc.id === doc.id)
      );
      return [...withoutDuplicates, ...newDocs];
    });

    setActiveId(newDocs[0]?.id || null);
  }

  async function openFile() {
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: "Python scripts", accept: PYTHON_ACCEPT }]
        });
        const file = await readFileHandle(handle);
        const rootId = makeId("file");

        addDocs([
          {
            id: `${rootId}:${file.name}`,
            origin: "file",
            rootId,
            rootName: "Opened File",
            name: file.name,
            relativePath: file.name,
            content: file.content,
            dirty: false,
            handle,
            writable: true
          }
        ]);
        setTerminal(`> opened ${file.name}`);
        return;
      }

      fileInputRef.current?.click();
    } catch (error) {
      setTerminal(error.message);
    }
  }

  async function openFolder() {
    try {
      if (window.showDirectoryPicker) {
        const directoryHandle = await window.showDirectoryPicker();
        const folderFiles = await collectPythonFilesFromDirectory(directoryHandle);

        if (!folderFiles.length) {
          setTerminal(`> ${directoryHandle.name} has no .py files`);
          return;
        }

        const rootId = makeId("folder");
        addDocs(
          folderFiles.map((file) => ({
            id: `${rootId}:${file.relativePath}`,
            origin: "folder",
            rootId,
            rootName: directoryHandle.name,
            name: file.name,
            relativePath: file.relativePath,
            content: file.content,
            dirty: false,
            handle: file.handle,
            writable: true
          }))
        );
        setTerminal(`> opened folder ${directoryHandle.name}\n> ${folderFiles.length} Python file(s) found`);
        return;
      }

      folderInputRef.current?.click();
    } catch (error) {
      setTerminal(error.message);
    }
  }

  async function handleFallbackFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!isPythonFile(file.name)) {
      setTerminal("Only .py files can be opened.");
      return;
    }

    const rootId = makeId("file");
    addDocs([
      {
        id: `${rootId}:${file.name}`,
        origin: "file",
        rootId,
        rootName: "Opened File",
        name: file.name,
        relativePath: file.name,
        content: await file.text(),
        dirty: false,
        writable: false
      }
    ]);
    setTerminal(`> opened ${file.name}\n> save-back needs Chrome or Edge on localhost`);
  }

  async function handleFallbackFolder(event) {
    const files = Array.from(event.target.files || []).filter((file) => isPythonFile(file.name));
    event.target.value = "";

    if (!files.length) {
      setTerminal("No .py files were found in that folder.");
      return;
    }

    const rootId = makeId("folder");
    const rootName = files[0].webkitRelativePath.split("/")[0] || "Opened Folder";
    const folderDocs = await Promise.all(
      files.map(async (file) => {
        const relativePath = normalizeRelativePath(
          file.webkitRelativePath.replace(`${rootName}/`, "") || file.name
        );

        return {
          id: `${rootId}:${relativePath}`,
          origin: "folder",
          rootId,
          rootName,
          name: file.name,
          relativePath,
          content: await file.text(),
          dirty: false,
          writable: false
        };
      })
    );

    addDocs(folderDocs);
    setTerminal(`> opened folder ${rootName}\n> save-back needs Chrome or Edge on localhost`);
  }

  async function saveActiveDoc() {
    if (!activeDoc) return;

    try {
      if (activeDoc.origin === "workspace") {
        await requestJson("/api/workspace-file", {
          method: "POST",
          body: JSON.stringify({
            path: activeDoc.relativePath,
            content: activeDoc.content
          })
        });
      } else if (activeDoc.handle?.createWritable) {
        const writable = await activeDoc.handle.createWritable();
        await writable.write(activeDoc.content);
        await writable.close();
      } else {
        throw new Error("This browser opened the file read-only. Use Chrome or Edge on localhost to save it back.");
      }

      replaceDoc(activeDoc.id, { dirty: false });
      setTerminal(`> saved ${activeDoc.relativePath}`);
    } catch (error) {
      setTerminal(error.message);
    }
  }

  async function runActiveDoc(debug = false) {
    if (!activeDoc || isBusy) return;
    if (!isPythonFile(activeDoc.relativePath)) {
      setTerminal("Only .py scripts can be run.");
      return;
    }

    setIsBusy(true);
    setTerminal(`> ${debug ? "debug" : "run"} ${activeDoc.relativePath}\n`);

    try {
      const body =
        activeDoc.origin === "workspace"
          ? {
              workspacePath: activeDoc.relativePath,
              content: activeDoc.content,
              debug
            }
          : {
              entryPath: activeDoc.relativePath,
              debug,
              files: docs
                .filter((doc) => doc.rootId === activeDoc.rootId && isPythonFile(doc.relativePath))
                .map((doc) => ({
                  path: doc.relativePath,
                  content: doc.id === activeDoc.id ? activeDoc.content : doc.content
                }))
            };

      const result = await requestJson("/api/run", {
        method: "POST",
        body: JSON.stringify(body)
      });

      const output = [
        result.stdout?.trimEnd(),
        result.stderr?.trimEnd(),
        `\n> process exited with code ${result.code}`
      ]
        .filter(Boolean)
        .join("\n");

      setTerminal((current) => `${current}${output || "\n> no output"}`);

      if (activeDoc.origin === "workspace") {
        replaceDoc(activeDoc.id, { dirty: false });
      }
    } catch (error) {
      setTerminal((current) => `${current}\n${error.message}`);
    } finally {
      setIsBusy(false);
    }
  }

  function updateActiveContent(value) {
    if (!activeDoc) return;
    replaceDoc(activeDoc.id, { content: value, dirty: true });
  }

  function updateCursor() {
    const editor = editorRef.current;
    if (!editor) {
      setCursor({ line: 1, column: 1 });
      return;
    }

    const beforeCursor = editor.value.slice(0, editor.selectionStart).split("\n");
    setCursor({
      line: beforeCursor.length,
      column: beforeCursor[beforeCursor.length - 1].length + 1
    });
  }

  function syncLineScroll() {
    if (lineNumberRef.current && editorRef.current) {
      lineNumberRef.current.scrollTop = editorRef.current.scrollTop;
    }
  }

  function handleEditorKeyDown(event) {
    if (event.key === "Tab") {
      event.preventDefault();
      const editor = event.currentTarget;
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const nextValue = `${editor.value.slice(0, start)}    ${editor.value.slice(end)}`;
      updateActiveContent(nextValue);

      requestAnimationFrame(() => {
        editor.selectionStart = start + 4;
        editor.selectionEnd = start + 4;
        updateCursor();
      });
    }
  }

  useEffect(() => {
    function handleKeydown(event) {
      const key = event.key.toLowerCase();

      if ((event.ctrlKey || event.metaKey) && key === "s") {
        event.preventDefault();
        saveActiveDoc();
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "enter") {
        event.preventDefault();
        runActiveDoc(false);
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [activeDoc, docs, isBusy]);

  return (
    <main className="workbench">
      <aside className="explorer" aria-label="Explorer">
        <div className="pane-title explorer-title">
          <span>Explorer</span>
          <div className="pane-actions">
            <button className="icon-button" type="button" title="Open Python file" onClick={openFile}>
              <Icon name="file" />
            </button>
            <button className="icon-button" type="button" title="Open folder" onClick={openFolder}>
              <Icon name="folder" />
            </button>
          </div>
        </div>

        <div className="file-list" role="listbox" aria-label="Python files">
          {groups.map((group) => (
            <section className="file-group" key={group.id}>
              <div className="group-name">{group.name}</div>
              {group.docs.map((doc) => (
                <button
                  className={`file-row${doc.id === activeDoc?.id ? " active" : ""}`}
                  type="button"
                  role="option"
                  aria-selected={doc.id === activeDoc?.id}
                  key={doc.id}
                  onClick={() => setActiveId(doc.id)}
                  title={doc.relativePath}
                >
                  <span className="file-icon">PY</span>
                  <span className="file-name">{doc.relativePath}</span>
                  {doc.dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
                </button>
              ))}
            </section>
          ))}
        </div>

        <input
          ref={fileInputRef}
          className="hidden-picker"
          type="file"
          accept=".py,text/x-python,text/plain"
          onChange={handleFallbackFile}
        />
        <input
          ref={folderInputRef}
          className="hidden-picker"
          type="file"
          webkitdirectory=""
          multiple
          onChange={handleFallbackFolder}
        />
      </aside>

      <header className="topbar">
        <input
          className="project-name"
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          aria-label="Project name"
        />
        <button className="tool-button save" type="button" title="Save with Ctrl+S" onClick={saveActiveDoc}>
          <Icon name="save" />
          <span>Save</span>
        </button>
        <button
          className="tool-button run"
          type="button"
          title="Run current Python script"
          disabled={isBusy}
          onClick={() => runActiveDoc(false)}
        >
          <Icon name="play" />
          <span>Run</span>
        </button>
        <button
          className="tool-button debug"
          type="button"
          title="Debug current Python script"
          disabled={isBusy}
          onClick={() => runActiveDoc(true)}
        >
          <Icon name="bug" />
          <span>Debug</span>
        </button>
      </header>

      <section className="editor-pane" aria-label="Python editor">
        <div className="tab-strip">
          <div className="active-tab">{activeDoc ? activeDoc.relativePath : "No Python file"}</div>
          <div className={`save-state${activeDoc?.dirty ? " unsaved" : ""}`}>
            {activeDoc?.dirty ? "Unsaved" : "Saved"}
          </div>
        </div>
        <div className="code-shell">
          <pre className="line-numbers" ref={lineNumberRef} aria-hidden="true">
            {Array.from({ length: lines }, (_, index) => index + 1).join("\n")}
          </pre>
          <textarea
            ref={editorRef}
            className="code-editor"
            value={activeDoc?.content || ""}
            spellCheck="false"
            aria-label="Python code"
            onChange={(event) => updateActiveContent(event.target.value)}
            onClick={updateCursor}
            onKeyUp={updateCursor}
            onSelect={updateCursor}
            onScroll={syncLineScroll}
            onKeyDown={handleEditorKeyDown}
            disabled={!activeDoc}
          />
        </div>
      </section>

      <section className="terminal-pane" aria-label="Terminal">
        <div className="pane-title">Terminal</div>
        <pre className="terminal-output">{terminal}</pre>
      </section>

      <footer className="statusbar">
        <span>{activeDoc?.relativePath || "No file"}</span>
        <span>{canUseFileSystemAccess ? "Local files and folders enabled" : "Fallback file picker"}</span>
        <span>
          Ln {cursor.line}, Col {cursor.column}
        </span>
      </footer>
    </main>
  );
}

createRoot(document.querySelector("#root")).render(<App />);

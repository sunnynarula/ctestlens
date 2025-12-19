import * as vscode from "vscode"; //This imports the VS Code Extension API
import * as path from "path";
import * as fs from "fs/promises";
import { constants as fsConstants } from "fs";
import { spawn } from "child_process";
import * as jsonc from "jsonc-parser";

type RootEntry = {
  // Presentation/grouping
  label?: string;          // optional display label
  groupByLabel?: boolean;  // optional: group multiple roots under same label
  // Exactly one of these:
  workspacePath?: string; // relative to workspace root
  path?: string;          // absolute path
  pattern: string;        // e.g. "test_*", "**/*_test"
};

type ConfigFile = {
  testRoots: RootEntry[];
};


const CONFIG_REL = ".vscode/ctestlens.jsonc";


/*
Big Picture First (mental model)
A VS Code extension is:
A Node.js program that VS Code loads into a separate process and calls lifecycle hooks on.
Key ideas:
 - VS Code owns the process
 - Your code registers callbacks
 - VS Code invokes them later (commands, events, tests, etc.)

Your extension does nothing by itself.
It only reacts when VS Code calls it.
*/
//Export means visible outside the file
export function activate(context: vscode.ExtensionContext) {//Lifecycle Entry Point for our extension called once
  const output = vscode.window.createOutputChannel("CTestLens");/*Creates A named tab(filter) in Output panel,
                                                                  Persistent across activations,
                                                                  Ideal for logs, diagnostics, test output
                                                                */
  output.appendLine("Extension activated (step 3.5).");//Like printing to console but in vs code console is unreliable
  output.show(true);//forces it visible
  context.subscriptions.push(output);//When this extension is deactivated, dispose of these resources.

  // --- Step 2: Testing API wiring ---

  // 1) Create the controller that "owns" a test tree in the Testing UI.
  //param1: id, param2:Human Readable text
  const controller = vscode.tests.createTestController(
    "cTestLens",
    "CTestLens"//This name appears in the Testing pane
  );
  context.subscriptions.push(controller);

  // Store binary execution paths keyed by TestItem id (used in Step 4).
  const binaryByTestId = new Map<string, string>();

  // Cache for mapping "test_xxx" -> Uri of "test_xxx.c" inside workspace.
  const sourceByBaseName = new Map<string, vscode.Uri | null>();

  /*
    If a config file does not already exist creates one.
   */
  async function initDefaultConfigIfMissing(showOutput = false) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage("Open a workspace folder first.");
      return;
    }
    const cfgUri = vscode.Uri.joinPath(folder.uri, CONFIG_REL);

    try {
      await vscode.workspace.fs.stat(cfgUri);//Fetching meta data if this works the next line is executed else quitely continue creating the config file
      if (showOutput) output.appendLine(`[init] config already exists: ${cfgUri.fsPath}`);
      return;//Config file already exists nothing to do function can return
    } catch {
      // missing -> create
    }

    // Ensure .vscode exists
    const vsdir = vscode.Uri.joinPath(folder.uri, ".vscode");
    try { await vscode.workspace.fs.createDirectory(vsdir); } catch {}

    // const defaultCfg: ConfigFile = {
    //   testRoots: [
    //     {
    //       label: "Local build tests",
    //       groupByLabel: true,
    //       workspacePath: "out/build/tests",
    //       pattern: "test_*"
    //     },
    //     {
    //       label: "CI tests",
    //       groupByLabel: true,
    //       path: "/home/user/tmp/ci-tests",
    //       pattern: "*_test"
    //     }
    //   ]
    // };

    const template = `{
  // CTestLens configuration file (JSONC: comments allowed).
  //
  // Each entry in "testRoots" defines a directory to scan for executables.

  "testRoots": [
    {
      // label (optional): display name in the Testing UI.
      "label": "Local build tests",

      // groupByLabel (optional, default false):
      // If true, roots with the same label appear under one shared group.
      "groupByLabel": true,

      // Choose ONE of:
      // 1) workspacePath (workspace-relative)
      "workspacePath": "out/build/tests",

      // 2) path (absolute OR workspace-relative, supports ./ and ../)
      // "path": "../../../build/tests",

      // pattern (required): base-name pattern like test_* or *_test recommended
      "pattern": "test_*"

      // Future ideas(not yet working):
      // "cwd": "\${workspaceFolder}",
      // "env": { "LD_LIBRARY_PATH": "..." },
      // "timeoutMs": 30000
    },

    {
      "label": "CI tests",
      "groupByLabel": true,
      "path": "/home/user/tmp/ci-tests",
      "pattern": "*_test"
    }
  ]
}
`;

const bytes = Buffer.from(template, "utf8");
await vscode.workspace.fs.writeFile(cfgUri, bytes);


    output.appendLine(`[init] created ${cfgUri.fsPath}`);
    vscode.window.showInformationMessage("CTestLens: Created .vscode/ctestlens.json");
  }

  function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
    // line/col are 1-based for user-friendly display
    let line = 1;
    let col = 1;

    const limit = Math.max(0, Math.min(offset, text.length));
    for (let i = 0; i < limit; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 10) { // '\n'
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, col };
  }

  /*
    Read config from default location, validate and return conig file object if valid else null
   */
  async function readConfig(): Promise<ConfigFile | null> {
    const folder = vscode.workspace.workspaceFolders?.[0];//WS root
    if (!folder) return null;//Not yet opened a workspace

    const cfgUri = vscode.Uri.joinPath(folder.uri, CONFIG_REL);//Config file path
    try {
      const raw = await vscode.workspace.fs.readFile(cfgUri);
      const text = Buffer.from(raw).toString("utf8");
      const errors: jsonc.ParseError[] = [];
      const parsed = jsonc.parse(text, errors, { allowTrailingComma: true }) as ConfigFile;

      if (errors.length > 0) {
        output.appendLine(`[config] JSONC parse errors in ${cfgUri.fsPath}:`);
        for (const e of errors) {
          const pos = offsetToLineCol(text, e.offset);
          output.appendLine(`  - line ${pos.line}, col ${pos.col}: errorCode=${e.error}`);
        }
        return null;
      }

      if (!parsed || !Array.isArray(parsed.testRoots)) {
        output.appendLine(`[config] invalid structure: expected { "testRoots": [...] }`);
        return null;
      }

      // Basic validation
      for (const [i, r] of parsed.testRoots.entries()) {
        const hasWorkspacePath = typeof r.workspacePath === "string";
        const hasPath = typeof r.path === "string";
        if (hasWorkspacePath === hasPath) {
          output.appendLine(`[config] root[${i}] must have exactly one of "workspacePath" or "path".`);
          return null;//Even if one entry is bad return null
        }
        if (typeof r.pattern !== "string" || r.pattern.length === 0) {
          output.appendLine(`[config] root[${i}] missing/empty "pattern".`);
          return null;//Even if one entry is bad return null
        }
        if (r.label !== undefined && typeof r.label !== "string") {
          output.appendLine(`[config] root[${i}] "label" must be a string if provided.`);
          return null;
        }
        if (r.groupByLabel !== undefined && typeof r.groupByLabel !== "boolean") {
          output.appendLine(`[config] root[${i}] "groupByLabel" must be a boolean if provided.`);
          return null;
        }
      }
      return parsed;
    } catch (e) {
      output.appendLine(`[config] missing or unreadable config: ${cfgUri.fsPath}`);
      output.appendLine(`[config] run command: "CTestLens: Create default config"`);
      return null;
    }
  }

  function resolveAgainstWorkspace(p: string): string | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;

    // Expand "~" (optional convenience; safe on Linux)
    if (p.startsWith("~" + path.sep)) {
      const home = process.env.HOME;
      if (home) p = path.join(home, p.slice(2));
    }

    // Absolute stays absolute
    if (path.isAbsolute(p)) return path.normalize(p);

    // Allow "./..." or "../..." or "relative"
    return path.normalize(path.join(folder.uri.fsPath, p));
  }

  /*
    Convert a workspace resource's path to the absolute path in the file system
   */
  async function resolveRootPath(r: RootEntry): Promise<string | null> {
    if (r.workspacePath) {
      return resolveAgainstWorkspace(r.workspacePath);
    }
    if (r.path) {
      // NEW: allow r.path to be absolute OR workspace-relative ("./", "../", etc.)
      return resolveAgainstWorkspace(r.path);
    }
    return null;
  }

  async function isDir(p: string): Promise<boolean> {
    try {
      return (await fs.stat(p)).isDirectory();
    } catch {
      return false;//If non existent
    }
  }

  async function isExecutable(filePath: string): Promise<boolean> {
    try {
      const st = await fs.stat(filePath);
      if (!st.isFile()) return false;
      await fs.access(filePath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  // Minimal glob support (intentionally simple + predictable):
  // - Matches based on basename only.
  // - Supports "*" wildcard in the basename pattern.
  // Examples:
  //   "test_*"     => basename matches "test_" prefix
  //   "**/*_test"  => basename matches "*_test"
  function matchesPattern(filePath: string, pattern: string): boolean {
    const base = path.basename(filePath);

    let namePattern = pattern;
    // If pattern contains "/", we only use the last segment (basename matcher).
    // This covers "**/*_test" well.
    if (pattern.includes("/")) {
      namePattern = pattern.split("/").pop() ?? pattern;
    }

    // Escape regex special chars except "*" as it is the only acceptable wild card
    const reSrc = "^" + namePattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*") + "$";

    const re = new RegExp(reSrc);
    return re.test(base);
  }
  /*
    Gives back an array of absolute path string of files inside the specified root dir.
   */
  async function walkFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    async function rec(dir: string) {
      let entries: any[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await rec(full);//Recusion to walk inside sub dir
        } else if (ent.isFile()) {
          out.push(full);
        }
      }
    }
    await rec(root);
    return out;
  }

  /*
    Map a found test executable to a local source file.
    This is used to make the click on the test name go to the correct file.
   */
  async function mapToSourceUri(baseName: string, relDirUnderRoot: string): Promise<vscode.Uri | null> {
    const cacheKey = `${baseName}@@${relDirUnderRoot}`;//Build a key
    if (sourceByBaseName.has(cacheKey)) return sourceByBaseName.get(cacheKey)!;//Return from cache

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;//Not a valid workspace

    const needle = `**/${baseName}.c`;//Look for matching file name
    const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, needle), "**/.git/**");

    if (matches.length === 1) {
      sourceByBaseName.set(cacheKey, matches[0]);
      return matches[0];
    }

    if (matches.length === 0) {
      output.appendLine(`[map] no source match for ${baseName}.c (relDir=${relDirUnderRoot})`);
      sourceByBaseName.set(cacheKey, null);
      return null;
    }

    //More than one files are matched, we will attempt to guess the best match using 3 criteria:
    //1. parent path match(highest score boost 1000x)
    //2. existance in test folder(higher score 50x)
    //3. more depth = more preference(TODO review maybe more depth should be given negative score)
    // Score candidates by how well their parent folders match relDirUnderRoot.
    const relParts = relDirUnderRoot && relDirUnderRoot !== "."
      ? relDirUnderRoot.split(path.sep).filter(Boolean)
      : [];

      //This is another function declaration
    const scoreCandidate = (uri: vscode.Uri): number => {
      const wsRel = path.relative(folder.uri.fsPath, uri.fsPath);
      const dirRel = path.dirname(wsRel);
      const srcParts = dirRel && dirRel !== "."
        ? dirRel.split(path.sep).filter(Boolean)
        : [];

      // Suffix match count: compare from the end
      let suffixMatches = 0;
      for (let i = 1; i <= Math.min(relParts.length, srcParts.length); i++) {
        if (relParts[relParts.length - i] === srcParts[srcParts.length - i]) suffixMatches++;
        else break;
      }

      // Bonus if source is under a "tests" folder anywhere (common convention)
      const hasTests = srcParts.includes("tests") ? 1 : 0;

      // Prefer deeper matches slightly (more context), but keep it small
      const depth = Math.min(srcParts.length, 20); // cap

      // Weighted score: suffixMatches dominates
      return suffixMatches * 1000 + hasTests * 50 + depth;
    };

    const ranked = matches
      .map(uri => ({ uri, score: scoreCandidate(uri) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Final tie-breaker: shortest path wins
        return a.uri.fsPath.length - b.uri.fsPath.length;
      });

    const chosen = ranked[0].uri;

    output.appendLine(
      `[map] ambiguous ${baseName}.c (relDir=${relDirUnderRoot}); chosen=${path.relative(folder.uri.fsPath, chosen.fsPath)} ` +
      `score=${ranked[0].score}`
    );

    // If you want extra visibility, log the top few:
    for (const r of ranked.slice(0, Math.min(3, ranked.length))) {
      output.appendLine(`  [map] candidate=${path.relative(folder.uri.fsPath, r.uri.fsPath)} score=${r.score}`);
    }

    sourceByBaseName.set(cacheKey, chosen);//Put into cache to avoid unnecessary recalculation
    return chosen;
  }

  /*
    Create a test group for every sub dir in the target root dirs
   */
  function getOrCreateGroup(rootGroup: vscode.TestItem, groupRelDir: string, groupCache: Map<string, vscode.TestItem>): vscode.TestItem {
    if (!groupRelDir || groupRelDir === ".") return rootGroup;

    const parts = groupRelDir.split(path.sep).filter(Boolean);
    let current = rootGroup;
    let acc = "";

    for (const p of parts) {
      acc = acc ? path.join(acc, p) : p;
      const key = `${rootGroup.id}::${acc}`;
      const existing = groupCache.get(key);
      if (existing) {
        current = existing;
        continue;
      }
      const id = `group:${key}`;
      const grp = controller.createTestItem(id, p);
      current.children.add(grp);
      groupCache.set(key, grp);
      current = grp;
    }
    return current;
  }

  async function discover() {
    binaryByTestId.clear();
    sourceByBaseName.clear();

    controller.items.forEach(item => controller.items.delete(item.id));

    const cfg = await readConfig();
    if (!cfg) return;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    output.appendLine(`[discover] roots=${cfg.testRoots.length}`);

    const labelGroupCache = new Map<string, vscode.TestItem>();  // label -> group item
    const labelGroupDirCache = new Map<string, Map<string, vscode.TestItem>>(); // label -> per-label groupCache for subdirs

    for (const [i, r] of cfg.testRoots.entries()) {
      const rootPath = await resolveRootPath(r);
      if (!rootPath) continue;

      // Choose label: user-provided or computed default
      const computedLabel = r.workspacePath ? `ws:${r.workspacePath}` : `abs:${rootPath}`;
      const effectiveLabel = (r.label && r.label.trim().length > 0) ? r.label.trim() : computedLabel;

      if (!rootPath) {
        output.appendLine(
          `[discover] root[${i}] label="${effectiveLabel}" INVALID path (could not resolve)`
        );
        continue;
      }

      output.appendLine(
        `[discover] root[${i}] label="${effectiveLabel}" resolved=${rootPath}`
      );

      const okDir = await isDir(rootPath);
      if (!okDir) {
        output.appendLine(
          `[discover] root[${i}] label="${effectiveLabel}" NOT A DIRECTORY`
        );
        continue;
      }

      // Decide container behavior
      const doGroupByLabel = r.groupByLabel === true;

      // Determine the parent container (either shared label group or per-entry root)
      let rootGroup: vscode.TestItem;
      let groupCache: Map<string, vscode.TestItem>;

      if (doGroupByLabel) {
        // Use (or create) a shared group at controller root for this label
        const existing = labelGroupCache.get(effectiveLabel);
        if (existing) {
          rootGroup = existing;
        } else {
          const groupId = `label:${effectiveLabel}`;
          rootGroup = controller.createTestItem(groupId, effectiveLabel);
          controller.items.add(rootGroup);
          labelGroupCache.set(effectiveLabel, rootGroup);
        }

        // Use (or create) a persistent directory-group cache for this label
        const existingDirCache = labelGroupDirCache.get(effectiveLabel);
        if (existingDirCache) {
          groupCache = existingDirCache;
        } else {
          groupCache = new Map<string, vscode.TestItem>();
          labelGroupDirCache.set(effectiveLabel, groupCache);
        }

        // Under the shared label group, we still want to keep different roots separate,
        // otherwise two roots with same relDir could collide. Create a per-root subgroup.
        const rootSubId = `root:${i}:${rootPath}`;
        const rootSubLabel = computedLabel; // shows origin (ws:... or abs:...) even when grouped
        const rootSubGroup = controller.createTestItem(rootSubId, rootSubLabel);
        rootGroup.children.add(rootSubGroup);

        // For directory grouping under *this root*, use a fresh cache tied to the rootSubGroup
        // to prevent collisions between different root paths.
        groupCache = new Map<string, vscode.TestItem>();
        rootGroup = rootSubGroup;
      } else {
        // Current behavior: one root group per entry
        const rootId = `root:${i}:${rootPath}`;
        rootGroup = controller.createTestItem(rootId, effectiveLabel);
        controller.items.add(rootGroup);

        groupCache = new Map<string, vscode.TestItem>();
      }

      const allFiles = await walkFiles(rootPath);
      let added = 0;

      for (const fp of allFiles) {
        if (!matchesPattern(fp, r.pattern)) continue;
        if (!(await isExecutable(fp))) continue;

        const rel = path.relative(rootPath, fp);
        const relDir = path.dirname(rel);
        const base = path.basename(fp);

        const parent = getOrCreateGroup(rootGroup, relDir, groupCache);

        const baseName = path.parse(base).name; // test_xxx
        const srcUri = await mapToSourceUri(baseName, relDir); // test_xxx.c inside workspace (Option B)

        const testId = `bin:${fp}`;
        const item = controller.createTestItem(testId, base, srcUri ?? undefined);
        item.description = rel;

        parent.children.add(item);
        binaryByTestId.set(testId, fp);
        added++;
      }

      output.appendLine(`[discover] root[${i}] added=${added} from ${rootPath} pattern=${r.pattern}`);
    }
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("cTestLens.initConfig", async () => {
      await initDefaultConfigIfMissing(true);
      output.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cTestLens.discover", async () => {
      output.appendLine("[cmd] rediscover");
      await discover();
      output.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cTestLens.openDocs", async () => {
      // Open the extension's packaged README.md (not the workspace README)
      const readmeUri = vscode.Uri.joinPath(context.extensionUri, "README.md");
      await vscode.commands.executeCommand("markdown.showPreview", readmeUri);
    })
  );


  // Discover on startup
  discover().catch(err => output.appendLine(`[discover] error: ${String(err)}`));

  // Rediscover when config changes
  // context.subscriptions.push(
  //   vscode.workspace.onDidChangeConfiguration(e => {
  //     if (e.affectsConfiguration("cBinaryTests.glob")) {
  //       output.appendLine("[config] glob changed, rediscovering");
  //       discover().catch(err => output.appendLine(`[discover] error: ${String(err)}`));
  //     }
  //   })
  // );

  // Run profile (still “no execution yet” — Step 4 will use binaryByTestId)
  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      const run = controller.createTestRun(request, "CTestLens run");

      // Build selection
      const selected: vscode.TestItem[] = [];
      if (request.include && request.include.length > 0) selected.push(...request.include);
      else controller.items.forEach(t => selected.push(t));

      // Flatten groups -> leaves
      const leaves: vscode.TestItem[] = [];
      const visit = (t: vscode.TestItem) => {
        if (t.children.size === 0) leaves.push(t);
        else t.children.forEach(ch => visit(ch));
      };
      for (const t of selected) visit(t);

      for (const test of leaves) {
        if (token.isCancellationRequested) break;

        const bin = binaryByTestId.get(test.id);
        if (!bin) {
          run.errored(test, new vscode.TestMessage("Missing binary path for test item."));
          continue;
        }

        run.enqueued(test);
        run.started(test);

        const startedAt = Date.now();
        const result = await spawnAndReport(bin, run, test, token);
        const durationMs = Date.now() - startedAt;

        if (result.kind === "pass") run.passed(test, durationMs);
        else if (result.kind === "fail") run.failed(test, result.message, durationMs);
        else run.errored(test, result.message, durationMs);
      }

      run.end();
    },
    true
  );
  controller.createRunProfile(
  "Debug",
  vscode.TestRunProfileKind.Debug,
  async (request, token) => {
    const run = controller.createTestRun(request, "CTestLens debug");

    const selected: vscode.TestItem[] = [];
    if (request.include && request.include.length > 0) selected.push(...request.include);
    else controller.items.forEach(t => selected.push(t));

    // Flatten to leaves
    const leaves: vscode.TestItem[] = [];
    const visit = (t: vscode.TestItem) => {
      if (t.children.size === 0) leaves.push(t);
      else t.children.forEach(ch => visit(ch));
    };
    selected.forEach(visit);

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      run.end();
      return;
    }

    for (const test of leaves) {
      if (token.isCancellationRequested) break;

      const bin = binaryByTestId.get(test.id);
      if (!bin) {
        run.errored(test, new vscode.TestMessage("Missing binary path for test item."));
        continue;
      }

      run.started(test);

      const dbgConfig: vscode.DebugConfiguration = {
        name: `Debug ${test.label}`,
        type: "cppdbg",
        request: "launch",
        program: bin,
        args: [],
        cwd: folder.uri.fsPath,
        MIMode: "gdb",
        miDebuggerPath: "/usr/bin/gdb",
        externalConsole: false
      };

      const ok = await vscode.debug.startDebugging(folder, dbgConfig);
      if (ok) run.passed(test);
      else run.errored(test, new vscode.TestMessage("Failed to start debugger."));
    }

    run.end();
  },
  true
);

  output.appendLine("Step 3.5 ready: config roots + grouping + source mapping.");
}

function normalizeTestOutput(s: string): string {
  s = s.replace(/\n/g, "\r\n"); //Required by the test run console
  return s;
}

async function spawnAndReport(
  bin: string,
  run: vscode.TestRun,
  test: vscode.TestItem,
  token: vscode.CancellationToken
): Promise<
  | { kind: "pass" }
  | { kind: "fail"; message: vscode.TestMessage }
  | { kind: "error"; message: vscode.TestMessage }
> {
  run.appendOutput(`\n$ ${bin}\n`);

  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";

    // const child = spawn(bin, [], {
    //   cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, // keep simple for now
    //   env: process.env
    // });
    const child = spawn(bin, [], {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      env: process.env,
      detached: true,       // <-- important: new process group
      stdio: ["ignore", "pipe", "pipe"]
    });

    // const kill = () => {
    //   try { child.kill("SIGKILL"); } catch {}
    // };
    // token.onCancellationRequested(() => kill());
    const killTree = () => {
      if (!child.pid) return;
      try {
        // negative pid kills the whole process group on Linux
        process.kill(-child.pid, "SIGINT");
      } catch {}
      setTimeout(() => { try { process.kill(-child.pid!, "SIGTERM"); } catch {} }, 300);
      setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1500);
    };

    token.onCancellationRequested(() => {
      run.appendOutput("\n[ctestlens] Cancel requested, terminating test...\n");
      killTree();
    });

    child.stdout.on("data", d => {
      const s = normalizeTestOutput(d.toString());
      stdout += s;
      run.appendOutput(s, undefined, test);
    });

    child.stderr.on("data", d => {
      const s = normalizeTestOutput(d.toString());
      stderr += s;
      run.appendOutput(s, undefined, test);
    });

    child.on("error", err => {
      resolve({ kind: "error", message: new vscode.TestMessage(String(err)) });
    });

    child.on("close", (code, signal) => {
      if (signal) {
        resolve({ kind: "fail", message: new vscode.TestMessage(`Terminated by signal: ${signal}`) });
        return;
      }
      if (code === 0) {
        resolve({ kind: "pass" });
      } else {
        // include a short tail to make failures visible even if output is huge
        const tail = (s: string, n: number) => (s.length <= n ? s : s.slice(s.length - n));
        const msgText =
          `Exit code: ${code}\n\n` +
          (stderr ? `--- stderr (tail) ---\n${tail(stderr, 4000)}\n` : "") +
          (stdout ? `--- stdout (tail) ---\n${tail(stdout, 4000)}\n` : "");
        resolve({ kind: "fail", message: new vscode.TestMessage(msgText) });
      }
      child.unref();
    });
  });
}

/*Deactivation Hook: Optional, Usually empty, Exists for symmetry
Most extensions don’t need it unless:
- you spawn child processes
- you manage sockets
- you manage external state
*/
export function deactivate() {}

// function getGlob(): string {
//   return vscode.workspace.getConfiguration("cBinaryTests").get<string>("glob", "**/build/**/test*");
// }

// async function isExecutable(filePath: string): Promise<boolean> {
//   try {
//     const st = await fs.stat(filePath);
//     if (!st.isFile()) return false;
//     await fs.access(filePath, fsConstants.X_OK);
//     return true;
//   } catch {
//     return false;
//   }
// }

// async function discoverTests(controller: vscode.TestController, output: vscode.OutputChannel) {
//   const folder = vscode.workspace.workspaceFolders?.[0];
//   if (!folder) {
//     output.appendLine("[discover] no workspace folder open");
//     return;
//   }

//   const glob = getGlob();
//   output.appendLine(`[discover] glob=${glob}`);

//   // Simple + reliable: rebuild the test tree from scratch
//   controller.items.forEach(item => controller.items.delete(item.id));

//   const pattern = new vscode.RelativePattern(folder, glob);
//   const uris = await vscode.workspace.findFiles(/*include:*/pattern, /*exclude:*/"**/.git/**");

//   let added = 0;
//   for (const uri of uris) {
//     const filePath = uri.fsPath;
//     if (!(await isExecutable(filePath))) continue;

//     const label = path.basename(filePath);
//     const id = `bin:${filePath}`; // stable id

//     const item = controller.createTestItem(id, label, uri);
//     item.description = path.relative(folder.uri.fsPath, filePath);
//     controller.items.add(item);
//     added++;
//   }

//   output.appendLine(`[discover] added=${added}`);
// }

import * as vscode from "vscode"; //This imports the VS Code Extension API
import * as path from "path";
import * as fs from "fs/promises";
import { constants as fsConstants } from "fs";

type RootEntry = {
  // Exactly one of these:
  workspacePath?: string; // relative to workspace root
  path?: string;          // absolute path
  pattern: string;        // e.g. "test_*", "**/*_test"
};

type ConfigFile = {
  testRoots: RootEntry[];
};


const CONFIG_REL = ".vscode/ctestlens.json";


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

    const defaultCfg: ConfigFile = {
      testRoots: [
        {
          workspacePath: "out/build/tests",
          pattern: "test_*"
        },
        {
          path: "/home/user/tmp/ci-tests",
          pattern: "**/*_test"
        }
      ]
    };

    const bytes = Buffer.from(JSON.stringify(defaultCfg, null, 2), "utf8");
    await vscode.workspace.fs.writeFile(cfgUri, bytes);

    output.appendLine(`[init] created ${cfgUri.fsPath}`);
    vscode.window.showInformationMessage("CTestLens: Created .vscode/ctestlens.json");
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
      const parsed = JSON.parse(text) as ConfigFile;

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
      }
      return parsed;
    } catch (e) {
      output.appendLine(`[config] missing or unreadable config: ${cfgUri.fsPath}`);
      output.appendLine(`[config] run command: "CTestLens: Create default config"`);
      return null;
    }
  }

  /*
    Convert a workspace resource's path to the absolute path in the file system
   */
  async function resolveRootPath(r: RootEntry): Promise<string | null> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;

    if (r.workspacePath) {
      return path.join(folder.uri.fsPath, r.workspacePath);
    }
    if (r.path) {
      return r.path;
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

    for (const [i, r] of cfg.testRoots.entries()) {
      const rootPath = await resolveRootPath(r);
      if (!rootPath) continue;

      const okDir = await isDir(rootPath);
      if (!okDir) {
        output.appendLine(`[discover] root[${i}] invalid path: ${rootPath}`);
        continue;
      }

      const rootLabel = r.workspacePath ? `ws:${r.workspacePath}` : `abs:${rootPath}`;
      const rootId = `root:${i}:${rootPath}`;

      // Root group item
      const rootGroup = controller.createTestItem(rootId, rootLabel);
      // For navigation, we can point root group to workspace folder (optional).
      //rootGroup.uri = folder.uri; FIXME Commented out check intent
      controller.items.add(rootGroup);

      const groupCache = new Map<string, vscode.TestItem>();

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
      const run = controller.createTestRun(request, "Step 3.5 run (no execution yet)");

      const testsToRun: vscode.TestItem[] = [];
      if (request.include && request.include.length > 0) testsToRun.push(...request.include);
      else controller.items.forEach(t => testsToRun.push(t));

      // Flatten groups → leaves only
      const leaves: vscode.TestItem[] = [];
      const visit = (t: vscode.TestItem) => {
        if (t.children.size === 0) leaves.push(t);
        else t.children.forEach(ch => visit(ch));
      };
      for (const t of testsToRun) visit(t);

      for (const test of leaves) {
        if (token.isCancellationRequested) break;

        run.enqueued(test);
        run.started(test);

        const bin = binaryByTestId.get(test.id);
        run.appendOutput(`(step 3.5) Would run: ${test.label}\n`);
        run.appendOutput(`(step 3.5) Binary path: ${bin ?? "<missing>"}\n`);

        run.passed(test);
      }

      run.end();
    },
    true
  );

  output.appendLine("Step 3.5 ready: config roots + grouping + source mapping.");
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

import * as vscode from "vscode"; //This imports the VS Code Extension API
import * as path from "path";
import * as fs from "fs/promises";
import { constants as fsConstants } from "fs";
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
  const output = vscode.window.createOutputChannel("CTestLens Tests");/*Creates A named tab(filter) in Output panel,
                                                                       Persistent across activations,
                                                                       Ideal for logs, diagnostics, test output
                                                                     */
  output.appendLine("Extension activated (step 3).");//Like printing to console but in vs code that is unreliable
  output.show(true);//forces it visible
  context.subscriptions.push(output);//When this extension is deactivated, dispose of these resources.

  // --- Step 2: Testing API wiring ---

  // 1) Create the controller that "owns" a test tree in the Testing UI.
  //param1: id, param2:Human Readable text
  const controller = vscode.tests.createTestController(
    "cBinaryTests",
    "CTestLens Tests"//This name appears in the Testing pane
  );
  context.subscriptions.push(controller);

  async function discover() {
    await discoverTests(controller, output);
  }

  // Command: manual rediscovery
  context.subscriptions.push(
    vscode.commands.registerCommand("cBinaryTests.discover", async () => {
      output.appendLine("[cmd] rediscover");
      await discover();
      output.show(true);
    })
  );

  // Discover on startup
  discover().catch(err => output.appendLine(`[discover] error: ${String(err)}`));

  // Rediscover when config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("cBinaryTests.glob")) {
        output.appendLine("[config] glob changed, rediscovering");
        discover().catch(err => output.appendLine(`[discover] error: ${String(err)}`));
      }
    })
  );

  // Run profile (still dummy execution for now)
  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      const run = controller.createTestRun(request, "Step 3 run (no execution yet)");

      const testsToRun: vscode.TestItem[] = [];
      if (request.include && request.include.length > 0) {
        testsToRun.push(...request.include);
      } else {
        controller.items.forEach(t => testsToRun.push(t));
      }

      for (const test of testsToRun) {
        if (token.isCancellationRequested) break;

        run.enqueued(test);
        run.started(test);

        // Keep it simple: no location mapping for now
        run.appendOutput(`(step 3) Would run: ${test.label}\n`);

        // Mark pass just to prove run pipeline works with discovered items
        run.passed(test);
      }

      run.end();
    },
    true
  );
}

/*Deactivation Hook: Optional, Usually empty, Exists for symmetry
Most extensions don’t need it unless:
- you spawn child processes
- you manage sockets
- you manage external state
*/
export function deactivate() {}

function getGlob(): string {
  return vscode.workspace.getConfiguration("cBinaryTests").get<string>("glob", "**/build/**/test*");
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

async function discoverTests(controller: vscode.TestController, output: vscode.OutputChannel) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    output.appendLine("[discover] no workspace folder open");
    return;
  }

  const glob = getGlob();
  output.appendLine(`[discover] glob=${glob}`);

  // Simple + reliable: rebuild the test tree from scratch
  controller.items.forEach(item => controller.items.delete(item.id));

  const pattern = new vscode.RelativePattern(folder, glob);
  const uris = await vscode.workspace.findFiles(/*include:*/pattern, /*exclude:*/"**/.git/**");

  let added = 0;
  for (const uri of uris) {
    const filePath = uri.fsPath;
    if (!(await isExecutable(filePath))) continue;

    const label = path.basename(filePath);
    const id = `bin:${filePath}`; // stable id

    const item = controller.createTestItem(id, label, uri);
    item.description = path.relative(folder.uri.fsPath, filePath);
    controller.items.add(item);
    added++;
  }

  output.appendLine(`[discover] added=${added}`);
}

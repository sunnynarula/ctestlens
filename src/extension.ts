import * as vscode from "vscode"; //This imports the VS Code Extension API
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
  const output = vscode.window.createOutputChannel("C Binary Tests");/*Creates A named tab(filter) in Output panel,
                                                                       Persistent across activations,
                                                                       Ideal for logs, diagnostics, test output
                                                                     */
  output.appendLine("Extension activated (step 2).");//Like printing to console but in vs code that is unreliable
  output.show(true);//forces it visible
  context.subscriptions.push(output);//When this extension is deactivated, dispose of these resources.

  const helloCmd = vscode.commands.registerCommand("cBinaryTests.hello", () => {
    /*This command can be triggered via:
      - Command Palette
      - keyboard shortcut
      - menu
      - another extension
    */
    vscode.window.showInformationMessage("Hello from C Binary Tests (step 2).");//pops up a UI notification
    output.appendLine("Hello command executed.");//logs to our Output channel
  });
  context.subscriptions.push(helloCmd);

  // --- Step 2: Testing API wiring ---

  // 1) Create the controller that "owns" a test tree in the Testing UI.
  //param1: id, param2:Human Readable text
  const controller = vscode.tests.createTestController(
    "cBinaryTests",
    "CTestLens Tests"//This name appears in the Testing pane
  );
  context.subscriptions.push(controller);

  // 2) Create one dummy test item and add it to the controller root.
  // TestItem needs:
  // - id: stable unique id (we'll later use file paths)
  // - label: shown in the UI
  // - uri: optional, used for mapping tests to files (we'll use it later)
  const dummy = controller.createTestItem(
    "dummy:test1",
    "Dummy test (always pass)"//This appears as a test nested under "CCTestLens Tests"
  );
  dummy.description = "Step 2 sanity check";
  controller.items.add(dummy);

  // 3) Add a Run profile. This defines what happens when user clicks Run.
  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      // A TestRun is a single execution session.
      const run = controller.createTestRun(request, "CTestLens Tests run");

      // Decide which tests to run:
      // - If user selected tests, request.include is populated.
      // - If they clicked Run-all, include is empty; we run everything.
      const testsToRun: vscode.TestItem[] = [];
      if (request.include && request.include.length > 0) {
        testsToRun.push(...request.include);
      } else {
        controller.items.forEach(t => testsToRun.push(t));
      }

      // Execute each test item (here: just mark pass).
      for (const test of testsToRun) {
        if (token.isCancellationRequested) break;

        run.enqueued(test);
        run.started(test);

        // Write output visible in the test output pane
        run.appendOutput(`Running ${test.label}\n`);

        // Fake "work"
        await new Promise(r => setTimeout(r, 50));

        // PASS
        run.passed(test);

        // If you want to see FAIL behavior, swap to:
        // run.failed(test, new vscode.TestMessage("Intentional fail (step 2)"));
      }

      run.end();
    },
    true // isDefault: makes this the default "Run"
  );

  output.appendLine("Step 2: TestController created; dummy test published.");
}

/*Deactivation Hook: Optional, Usually empty, Exists for symmetry
Most extensions don’t need it unless:
- you spawn child processes
- you manage sockets
- you manage external state
*/
export function deactivate() {}

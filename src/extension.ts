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
  output.appendLine("Extension activated (step 1).");//Like printing to console but in vs code that is unreliable
  output.show(true);//forces it visible

  const disposable = vscode.commands.registerCommand("cBinaryTests.hello", () => {
    /*This command can be triggered via:
      - Command Palette
      - keyboard shortcut
      - menu
      - another extension
    */
    vscode.window.showInformationMessage("Hello from C Binary Tests (step 1).");//pops up a UI notification
    output.appendLine("Hello command executed.");//logs to our Output channel
  });

  context.subscriptions.push(output, disposable);//You’re telling VS Code: When this extension is deactivated, dispose of these resources.
}

/*Deactivation Hook: Optional, Usually empty, Exists for symmetry
Most extensions don’t need it unless:
- you spawn child processes
- you manage sockets
- you manage external state
*/
export function deactivate() {}

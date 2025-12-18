import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("C Binary Tests");
  output.appendLine("Extension activated (step 1).");
  output.show(true);

  const disposable = vscode.commands.registerCommand("cBinaryTests.hello", () => {
    vscode.window.showInformationMessage("Hello from C Binary Tests (step 1).");
    output.appendLine("Hello command executed.");
  });

  context.subscriptions.push(output, disposable);
}

export function deactivate() {}

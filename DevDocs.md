# Documentation

## Our First Command after creating project folder: npm init -y
Creates package.json as a Node project manifest.
VS Code extensions are distributed and built like Node packages.

## npm i --save-dev typescript @types/node @types/vscode
typescript: compiler that turns .ts → .js

@types/node: type definitions so TS understands Node APIs (fs, path, child_process, etc.)

@types/vscode: type definitions for VS Code’s extension API (vscode.window, vscode.commands, etc.)

Important: these are devDependencies because they’re only needed to build and typecheck. At runtime you ship JS.

## tsconfig.json

This is your compiler contract.

Key fields:
- "rootDir": "src": “my TypeScript lives here”
- "outDir": "dist": “put compiled JS here”
- "module": "commonjs": “emit CommonJS JS (require/module.exports)”
- "sourceMap": true: enables stepping through TS while debugging.

## package.json fields (the ones that mattered)
"main": "./dist/extension.js"

This is the entry point that VS Code loads when it activates your extension.

You author src/extension.ts

tsc compiles it to dist/extension.js

VS Code runs that compiled JS

If main points wrong → extension “activates” fails or doesn’t run.

"activationEvents": ["onStartupFinished"]

This tells VS Code when to load your extension.

onStartupFinished = load after VS Code finishes startup

Alternative patterns you’ll use later:

onCommand:cBinaryTests.hello (only activate when command runs)

workspaceContains:... (activate only for certain files)

onLanguage:c (activate when C files are used)

This is one of the biggest knobs for performance and predictability.

"contributes": { "commands": [...] }

This adds UI-visible “hooks” that VS Code knows about without running your code.

In Step 1 you contributed:

a command ID: cBinaryTests.hello

a title: “C Binary Tests: Hello”

This makes it show up in Command Palette.

Important distinction:

Contribution = “VS Code, here’s a thing I provide”

Implementation = your code that runs when that thing is invoked

## src/extension.ts

This is your extension’s runtime code.

export function activate(context)

VS Code calls this exactly once per window when the extension is activated.

Output Channel
const output = vscode.window.createOutputChannel("C Binary Tests");


This gives you a log sink inside VS Code (Output panel).
For extension development, Output Channel is your “printf”.

Command registration
vscode.commands.registerCommand("cBinaryTests.hello", () => { ... })


This wires the command ID from package.json to actual code.

If the command exists in package.json but you forget to register it → it appears but does nothing / errors.

context.subscriptions.push(...)

This is lifecycle management:

When the window closes or extension unloads, VS Code disposes these.

Prevents leaks, stale handlers, repeated registrations.

## .vscode/launch.json

This is not part of the extension—this is your developer workflow.

"type": "extensionHost"


Means: “launch a new VS Code instance and load my extension for debugging”.

"args": ["--extensionDevelopmentPath=${workspaceFolder}"]


This is crucial:

it tells the new VS Code instance: “load extension from this folder on disk”

so you don’t need to package/install it to test

"outFiles": ["${workspaceFolder}/dist/**/*.js"]


So breakpoints in TS map to compiled JS via sourcemaps.

## Why tests only appear in the Extension Development Host window

Because your extension is only loaded in that sandbox instance via --extensionDevelopmentPath.
Your normal VS Code window is not loading it.

Later, packaging (.vsix) installs it globally.

# A “project management” map (so you can maintain it)

Here’s the stable structure you’re building:

src/ → TypeScript source (you edit here)

dist/ → compiled JS (generated; you don’t hand-edit)

package.json → extension manifest (activation + contributions)

tsconfig.json → build settings

.vscode/launch.json → debug workflow

And your future code will live in modules, not one file:

src/extension.ts (wiring / activation)

src/discovery.ts (glob → list executables)

src/run.ts (spawn + stream output + pass/fail)

src/debug.ts (gdb launching)

We’ll build those one at a time.
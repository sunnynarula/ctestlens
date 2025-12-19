# CTestLens (Plain C Binary Tests for VS Code)

CTestLens is a minimal VS Code Testing integration for C (and C-like) projects where tests are ordinary executables.

It is designed for setups where:
- You already have a custom build system.
- Build artifacts may live outside the source workspace.
- You do **not** want to use CMake/CTest.
- You want VS Code’s **Testing (beaker) UI** to discover and run your test binaries.

Core philosophy:
- **One executable = one test item**
- **Exit code decides PASS/FAIL**
- Output is streamed to the Testing output pane.
- Coverage and report generation remain orthogonal (CI/build scripts).

References:
- VS Code Testing API: https://code.visualstudio.com/api/extension-guides/testing
- VS Code Extension API: https://code.visualstudio.com/api/references/vscode-api
- VS Code JSON schema validation: https://code.visualstudio.com/docs/languages/json#_json-schemas-and-settings


## Features

- Discover test executables from one or more "roots".
  - Roots may be workspace-relative or outside the workspace.
- Group tests in the Testing UI by subfolder structure.
- Run tests from the Testing UI.
  - PASS = exit code 0
  - FAIL = non-zero
- Stream stdout/stderr into VS Code’s test output.
- Supports stopping hung tests by terminating the process (and process group on Linux).
- Optional: Debug from Testing UI under gdb via `cppdbg` (requires MS C/C++ extension).


## Quick Start

1) Open the extension project in VS Code.

2) Launch Extension Development Host:
- Press `F5`

3) In the Extension Development Host window:
- Open Command Palette (`Ctrl+Shift+P`)
- Run: `CTestLens: Create default config`

This creates a config file at:

- `.vscode/ctestlens.jsonc`

4) Edit `.vscode/ctestlens.jsonc` to point to your test binaries.

5) Run: `CTestLens: Rediscover tests`

6) Open Testing (beaker icon) and run tests.


## Configuration File: .vscode/ctestlens.jsonc

The config file is JSONC (JSON with comments). A typical config contains:

- `testRoots`: list of discovery roots
  - Each root specifies:
    - where to search for binaries (`workspacePath` or `path`)
    - what filenames count as test executables (`pattern`)
    - optional presentation fields (`label`, `groupByLabel`)

Example:

```jsonc
{
  "testRoots": [
    {
      "label": "Local build tests",
      "groupByLabel": true,
      "workspacePath": "out/build/tests",
      "pattern": "test_*"
    },
    {
      "label": "CI tests",
      "groupByLabel": true,
      "path": "../../../build/ci/tests",
      "pattern": "**/*_test"
    }
  ]
}
```

## Root fields

- workspacePath (string)
  - Workspace-relative path to the test root, e.g. out/build/tests
- path (string)
  - Absolute OR workspace-relative path to the test root.
  - Workspace-relative forms are allowed:
    - ./../../../build/tests
    - ../../../build/tests
- pattern (string)
  - Filename pattern for test executables.
  - Intended to be simple and robust (typically based on basename):
    - test_*
    - *_test
    - **/*_test (treated like basename *_test)
- label (string, optional)
  - Display name for the root in the Testing UI.
- groupByLabel (boolean, optional)
  - If true, roots with the same label appear under a shared label group.

## Source Navigation ("Go to Test")

CTestLens can map a binary to a source file in the workspace using a naming convention:
- binary test_foo -> source test_foo.c

If multiple test_foo.c exist, CTestLens uses folder-name matching heuristics to choose the most likely candidate.

Tip:
- Keep test file names unique to make navigation deterministic.

## Debugging Tests

Debugging from Testing UI uses gdb via the cppdbg debugger and requires MS C/C++ extension:

- https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools

Usage:
- In the Testing UI, click Debug on a test item.

If you run into a hung test:
- Click Stop in the Testing toolbar.
- CTestLens will terminate the process (and its process group).

## Coverage (Orthogonal)

CTestLens does not generate coverage itself.
Typical GCC workflow:
- compile with coverage instrumentation
- run tests
- collect with lcov
- view via HTML (genhtml) or a VS Code coverage viewer extension

LCOV:
- https://github.com/linux-test-project/lcov

## Troubleshooting
- “No tests discovered”
  - Check Output panel: CTestLens
  - Look for the printed resolved root paths.
  - Ensure binaries are executable (chmod +x ...).
- “Go to Test” doesn’t open the right file
  - Ensure test_xxx.c exists in the workspace.
  - Avoid duplicate test filenames across the repo.
- “Stop doesn’t stop hung tests”
  - Ensure the runner is using process-group termination on Linux (detached spawn + kill(-pid)).

## Platform Support

CTestLens is currently developed and tested on Linux (Ubuntu).

Known limitations on Windows:
- Executable discovery uses POSIX execute-permission checks (`X_OK`), which do not map cleanly to Windows.
- Stopping hung tests uses POSIX process-group termination (negative PID kill), which is not supported on Windows.
- Debug integration currently assumes `gdb` at `/usr/bin/gdb`.

Future Windows support is possible by:
- Treating `.exe/.bat/.cmd` (and `PATHEXT`) as executable,
- Using Windows process-tree termination (e.g., `taskkill /T /F`),
- Supporting `cppvsdbg` or configurable debugger backends.

## License

MIT

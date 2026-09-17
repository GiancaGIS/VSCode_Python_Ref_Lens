# Python Reference Lens

Minimal VS Code extension that shows semantic Python reference counts above functions and methods.

It deliberately delegates symbol discovery and reference resolution to VS Code's active language providers (normally Pylance for Python), instead of parsing Python itself.

## Behavior

```python
2 references

def calculate_total(...):
    ...
```

Click the CodeLens to open VS Code's standard references UI.

## Requirements

- Visual Studio Code
- Node.js + npm (for development)
- A Python language provider with reference support; Pylance is recommended

## Build the installable VSIX

After installing Node.js 22+:

```powershell
npm install
npm run package
```

`npm run package` automatically compiles the TypeScript extension through the `vscode:prepublish` hook and creates:

```text
python-reference-lens-1.0.0.vsix
```

in the project root. The VSIX can be copied to another computer and installed from **Extensions > ... > Install from VSIX...**, or with:

```powershell
code --install-extension python-reference-lens-1.0.0.vsix
```

`@vscode/vsce` is included as a local development dependency, so no global `vsce` installation is required.

## Run locally

1. Open this folder in VS Code.
2. Run `npm install`.
3. Make sure the Microsoft Python/Pylance extensions are enabled in the Extension Development Host.
4. Press `F5` and choose **Run Python Reference Lens**.
5. Open `examples/demo.py` in the new VS Code window.

Expected examples:

- `Calculator.add` should have references from the two calls in `main`.
- `unused_method` should show `0 references`.
- `greet` should show references from `main` and from `caller.py` (the provider may also count its import).

The exact count is controlled by the active language provider and can include semantic usages that are not direct calls.

To check updates across files, keep `demo.py` visible and open `caller.py` beside it.
Add or remove a `greet(...)` call in `caller.py`: the count above `greet` in `demo.py`
should update after you stop typing, subject to the language provider's response time.
Also try renaming or deleting `caller.py` and undoing the operation.

## Tests

```powershell
npm test
```

This compiles the extension and runs regression tests with Node's built-in test runner.
The tests simulate VS Code events and language provider responses, including calls
across files, concurrent requests, cancellation, late responses and provider failures.
They do not launch VS Code or Pylance; use the F5 workflow above for an integration check.

## Settings

```json
{
  "pythonReferenceLens.enabled": true,
  "pythonReferenceLens.showZeroReferences": true
}
```

## Command

- `Python Reference Lens: Refresh`

Refresh clears the cache and requests an immediate update. If a provider request fails,
the lens shows **References unavailable** with a click-to-retry action. Details appear
in **View > Output > Python Reference Lens**.

## Architecture

1. `vscode.executeDocumentSymbolProvider` locates functions and methods.
2. A lazy `CodeLens` is created for each symbol.
3. `resolveCodeLens()` calls `vscode.executeReferenceProvider` only when VS Code resolves a lens.
4. Clicking the result invokes VS Code's built-in `editor.action.showReferences` UI.

Reference results are cached, and concurrent requests for the same symbol share one
provider request. Python edits invalidate all cached counts because callers can live
in other files. Refresh notifications are grouped after 400 ms of quiet. Saves,
document closes, workspace folder changes and file creation/change/deletion also
invalidate the cache; filesystem watching covers `.py`, `.pyi` and `.pyw` files.
Results from before an invalidation or document version change are discarded. The
cache holds at most 500 symbol results.

Counts still depend on the language provider's current index. If indexing is in
progress, use **Python Reference Lens: Refresh** when it finishes.

## Next candidates

- distinguish calls from generic references
- test vs production reference counts
- implementations / overrides
- incoming call hierarchy
- Marketplace metadata / publishing

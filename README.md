# Python Reference Lens

<img src="media/icon.png" alt="Python Reference Lens icon" width="128" />

VS Code extension that shows semantic Python references, calls, implementations and callers above functions and methods.

It deliberately delegates symbol discovery and reference resolution to VS Code's active language providers (normally Pylance for Python), instead of parsing Python itself.

## Behavior

Above a function or method, the extension can display a row such as:

```text
4 references (3 production, 1 test) | 3 calls | 1 other reference | 0 implementations / overrides | 2 callers
```

These labels answer different questions about the same symbol:

| Label | Meaning in this example | What clicking opens |
| --- | --- | --- |
| **4 references** | Four places refer to the function or method, including calls and other uses. | All reference locations. |
| **(3 production, 1 test)** | Three references are in production files and one is in a file classified as a test. This is a breakdown of the four references, not extra references. | The full references list; the breakdown is part of the references label. |
| **3 calls** | Three distinct places call the function or method. | The individual call sites. |
| **1 other reference** | One reference is not identified as a call site, such as storing the function in a variable or importing it. | References not matched to call sites. |
| **0 implementations / overrides** | The provider found no implementation or override targets for this symbol. | Implementation/override locations, when present. |
| **2 callers** | Two distinct functions or methods make the calls. One of them can call the symbol more than once. | VS Code's incoming call hierarchy, which lets you explore who calls whom. |

The four example references above comprise three call sites and one other reference.
Results are deduplicated, and the symbol's own declaration is excluded from references
and implementations. All features are enabled by default and can be switched off independently.

### Example: calls, other references and callers

Consider this standalone `example.py` file:

```python
def greet(name: str) -> str:
    return f"Hello {name}"


greeting_callback = greet          # One reference to a function value; no call here.


def welcome_pair() -> None:
    print(greet("Anna"))           # Call site 1, inside welcome_pair.
    print(greet("Marco"))          # Call site 2, also inside welcome_pair.


def welcome_guest() -> None:
    print(greet("Guest"))          # Call site 3, inside welcome_guest.
```

With no other references in the workspace, and a provider that reports these uses,
the labels above `greet` would be:

```text
4 references (4 production, 0 test) | 3 calls | 1 other reference | 0 implementations / overrides | 2 callers
```

The three `greet(...)` expressions contribute **3 calls**, but they belong to only
**2 callers**: `welcome_pair` and `welcome_guest`. The assignment
`greeting_callback = greet` contributes **1 other reference**, bringing the total
to **4 references**. All four are in the production file `example.py`.

These are static code locations, not execution statistics. Calling `welcome_pair`
a thousand times does not increase the count. Likewise, one `greet(...)` expression
inside a loop remains one call site.

An import such as `from example import greet` can also contribute an **other reference**
if the provider reports it. Calling through `greeting_callback(...)` depends on the
provider's ability to resolve aliases; the labels do not measure runtime behavior.

### Example: production versus test references

Now add `tests/test_example.py` alongside the previous example:

```python
import example


def test_greeting() -> None:
    assert example.greet("Test") == "Hello Test"
```

The `example.greet(...)` expression adds one call site and one reference in a test
file. With both files indexed, the illustrative counts above `greet` become:

```text
5 references (4 production, 1 test) | 4 calls | 1 other reference | 0 implementations / overrides | 3 callers
```

`test_greeting` is the third caller. The `import example` statement references the
module, rather than the `greet` function itself.

The **test** label comes from the file path matching `testFilePatterns`, such as
`tests/test_example.py`; the extension does not run the test. **Production** means
the path does not match any test pattern. The breakdown includes all references,
so importing `greet` directly in a test file may add another test reference as well.
See [Settings](#settings) to customize the patterns for your project.

### Example: implementations and overrides

```python
class Calculator:
    def add(self, a: int, b: int) -> int:
        return a + b


class VerboseCalculator(Calculator):
    def add(self, a: int, b: int) -> int:
        result = super().add(a, b)
        print(result)
        return result
```

`VerboseCalculator.add` overrides `Calculator.add`. If the implementation provider
reports that relationship, the label above **`Calculator.add`** includes
**1 implementation / override**. Clicking it opens the overriding method.
Providers may also report concrete implementations of abstract methods through
this same label.

The override definition itself is not a call to the base method. The expression
`super().add(a, b)` is a call site for `Calculator.add`, and `VerboseCalculator.add`
is its caller when the hierarchy provider resolves it. The implementation count
is separate from the reference and call counts. A zero implementation count says
nothing about how often the method is called.

You can explore these cases in [examples/demo.py](examples/demo.py),
[examples/caller.py](examples/caller.py) and
[examples/tests/test_demo.py](examples/tests/test_demo.py). Those files contain
additional uses, so their totals differ from the standalone examples above.

### Choosing which labels to show

For a compact display with only the total reference count and production/test
breakdown, put this in your VS Code settings:

```json
{
  "pythonReferenceLens.showCalls": false,
  "pythonReferenceLens.showReferenceBreakdown": true,
  "pythonReferenceLens.showImplementations": false,
  "pythonReferenceLens.showIncomingCalls": false
}
```

Enable `showCalls` to see call sites and other references, `showIncomingCalls` to
explore callers, or `showImplementations` to navigate implementations and overrides.
Set `showReferenceBreakdown` to `false` as well if you only want **N references**.

## Requirements

- Visual Studio Code
- Node.js + npm (for development)
- A Python language provider with reference support; Pylance is recommended
- Call hierarchy and implementation provider support for the corresponding extra counts

## Build the installable VSIX

After installing Node.js 22+:

```powershell
npm install
npm run package
```

`npm run package` automatically compiles the TypeScript extension through the `vscode:prepublish` hook and creates:

```text
python-reference-lens-x.x.x.vsix
```

in the project root. The VSIX can be copied to another computer and installed from **Extensions > ... > Install from VSIX...**, or with:

```powershell
code --install-extension python-reference-lens-x.x.x.vsix
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
- `caller.py` also stores `greet` in a callback variable: that usage should appear under **Other references** when the provider distinguishes it.
- `examples/tests/test_demo.py` adds test references to `greet` and `Calculator.add`; their totals should include a nonzero test count.
- `Calculator.add` has an override in `VerboseCalculator.add`; click **Implementations / overrides** to inspect it when supported by the provider.
- Click **Callers** above `greet` to browse the incoming hierarchy. Clicking **Calls** opens the individual call sites instead.

The exact results depend on the active language provider's index. Call classification
uses semantic hierarchy results, not Python text parsing. A reference absent from the
hierarchy is classified as an **other reference**; this does not prove it is never
called at runtime (for example through aliases or dynamic dispatch). Call ranges and
reference ranges can differ, so counts from the two providers need not add up exactly.

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
They also cover call-site/caller deduplication, test file patterns and per-folder
settings, implementation links, feature toggles and incoming hierarchy navigation.
They do not launch VS Code or Pylance; use the F5 workflow above for an integration check.

## Settings

```json
{
  "pythonReferenceLens.enabled": true,
  "pythonReferenceLens.showZeroReferences": true,
  "pythonReferenceLens.showCalls": true,
  "pythonReferenceLens.showReferenceBreakdown": true,
  "pythonReferenceLens.showImplementations": true,
  "pythonReferenceLens.showIncomingCalls": true,
  "pythonReferenceLens.peekStyle": "theme",
  "pythonReferenceLens.peekColors": {},
  "pythonReferenceLens.testFilePatterns": [
    "**/{test,tests}/**",
    "**/test_*.py",
    "**/*_test.py",
    "**/conftest.py"
  ]
}
```

`showCalls` controls both the calls and other-reference entries.
`showZeroReferences: false` hides zero counts for all entries; unavailable results
remain visible with a retry action. To restore only the original reference counter,
disable `showCalls`, `showReferenceBreakdown`, `showImplementations` and `showIncomingCalls`.

`testFilePatterns` contains case-sensitive glob patterns matched against paths relative
to each reference's workspace folder, with `/` separators; files outside the workspace
use absolute paths. Patterns include hidden directories. Each caller's folder settings
are respected in multi-root workspaces. Customize the list for directories such as
`**/qa/**` or `**/specs/**`. Nonmatching paths count as production; an empty list
classifies everything as production. This classification is a file naming convention,
not a test-runner discovery result. The breakdown covers all references, including
imports and callbacks, and clicking it opens the full reference list.

### Reference popup appearance

If the reference popup blends into the code behind it, open VS Code Settings,
search for **Python Reference Lens: Peek Style**, and select **contrast**.
The default is `theme`, so installing the extension alone does not change the popup.

#### Enable a more visible popup

1. Install the updated extension and open your project folder or workspace.
2. Open a Python file to activate Python Reference Lens.
3. Open **Preferences: Open Settings (UI)** from the Command Palette.
4. Select the **Workspace** settings tab and search for `pythonReferenceLens.peekStyle`.
5. Choose **contrast**, then click a **references** or **calls** CodeLens above a function.

The popup will use a visible border, a distinct title bar, separate code/list
backgrounds and a highlighted selected reference. If the popup is already open,
close it with **Escape** and click the CodeLens again to inspect the result.

Alternatively, add this to your workspace `settings.json`:

```json
{
  "pythonReferenceLens.peekStyle": "contrast"
}
```

| Style | Appearance |
| --- | --- |
| `theme` (default) | Use the existing VS Code theme. Restore colors previously changed by this extension. |
| `accented` | Emphasize the outline and title bar while keeping the theme's code and result backgrounds. |
| `contrast` | Add distinct backgrounds for the title, reference list and code preview, plus a visible outline and selection highlights. |
| `custom` | Start from `contrast` and override selected colors with `peekColors`. |

Presets adapt to light, dark and high-contrast themes. The code preview keeps the
editor theme's syntax highlighting.

#### Customize individual colors

Choose `custom` to use `peekColors`; this object has no effect while another style
is selected. For example, this palette suits a dark editor theme:

```json
{
  "pythonReferenceLens.peekStyle": "custom",
  "pythonReferenceLens.peekColors": {
    "border": "#FFD43B",
    "titleBackground": "#173D60",
    "titleForeground": "#F1F7FF",
    "editorBackground": "#182536",
    "resultsBackground": "#213248",
    "resultForeground": "#DAE7F5",
    "selectionBackground": "#315C85",
    "selectionForeground": "#FFFFFF",
    "matchBackground": "#FFD43B33"
  }
}
```

| `peekColors` property | Part of the popup |
| --- | --- |
| `border` | Outer outline and the outline around matching code. |
| `titleBackground` | Title bar background. |
| `titleForeground` | Title and description text. |
| `editorBackground` | Code preview and line-number gutter background. |
| `resultsBackground` | Reference list background. |
| `resultForeground` | File names and reference snippets in the list. |
| `selectionBackground` | Background of the selected reference. |
| `selectionForeground` | Text of the selected reference. |
| `matchBackground` | Highlight behind matches in the code and reference list. |

Omitted colors use the preset. Use translucent match highlights to keep code readable;
the last two digits in `#FFD43B33` set the opacity. Explicit custom colors remain the
same when switching themes; only the unspecified preset colors adapt.

For a smaller customization, change only the border and leave the rest adaptive:

```json
{
  "pythonReferenceLens.peekStyle": "custom",
  "pythonReferenceLens.peekColors": {
    "border": "#FFD43B"
  }
}
```

#### Scope and restoring the original appearance

The popup is VS Code's native Peek view. These styles apply to **all native Peek
views in the current workspace window**, including references in other languages.
They use the supported [Peek theme colors](https://code.visualstudio.com/api/references/theme-color#peek-view-colors);
the extension cannot independently change the native popup's font, padding, border
thickness or corner shape.

An open folder or workspace is required. After the extension activates for Python,
style changes take effect without reloading. Non-default styles write a block for
the active theme inside the workspace's `workbench.colorCustomizations` setting
(`.vscode/settings.json` or the `.code-workspace` file). Global user settings are
not modified. In a multi-root workspace, the style applies to the whole workspace.

Selecting `theme`, setting `pythonReferenceLens.enabled` to `false`, or a normal
extension shutdown restores previous values. Other color settings and manual changes
made after applying the style are preserved. A saved backup allows restoration after
an interrupted extension session. If you intend to uninstall the extension, select
`theme` first to restore the colors immediately. Color blocks written in workspace
settings may appear in source control; review them before committing shared settings.

To restore the original appearance, set:

```json
{
  "pythonReferenceLens.peekStyle": "theme"
}
```

Your `peekColors` choices can remain saved for later; they are inactive in `theme`
mode. If the setting is missing from the UI, make sure the installed VSIX includes
this feature and reload VS Code after updating. If applying a style fails, details
appear in **View > Output > Python Reference Lens** under **Peek appearance**.

## Command

- `Python Reference Lens: Refresh`

Refresh clears the cache and requests an immediate update. If a provider request fails,
the affected lens shows an **unavailable** message with a click-to-retry action. Details appear
in **View > Output > Python Reference Lens**.

Absent or failed hierarchy results never become a zero-call count. Other-reference
classification requires successful reference and hierarchy results. An unsupported
implementation provider may return an empty list, which VS Code does not distinguish
from a supported provider finding zero implementations. Individual feature switches
can hide entries that your provider does not support.

## Architecture

1. `vscode.executeDocumentSymbolProvider` locates functions and methods.
2. Lazy `CodeLens` entries are created for the enabled features of each symbol.
3. Resolution requests only the needed data: `vscode.executeReferenceProvider`,
   `vscode.executeImplementationProvider`, or `vscode.prepareCallHierarchy` followed
   by `vscode.provideIncomingCalls`. Calls, other references and callers share hierarchy requests.
4. Counts open the standard `editor.action.showReferences` UI. The callers entry
   selects the symbol, opens `editor.showCallHierarchy` and selects incoming calls.

Provider commands use the [VS Code built-in command API](https://code.visualstudio.com/api/references/commands).

Successful results are cached by symbol and operation, and concurrent lookups share
provider requests. Failed results are not cached. Python edits invalidate all cached counts because callers can live
in other files. Refresh notifications are grouped after 400 ms of quiet. Saves,
document closes, workspace folder changes and file creation/change/deletion also
invalidate the cache; filesystem watching covers `.py`, `.pyi` and `.pyw` files.
Results from before an invalidation or document version change are discarded. The
cache holds at most 500 results across references, implementations and incoming calls.

Counts still depend on the language provider's current index. If indexing is in
progress, use **Python Reference Lens: Refresh** when it finishes.

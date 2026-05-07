# EdgeTerm Display API

EdgeTerm Display is a browser-native graphics/output layer for EdgeTerm Workspace. It gives Python and other Pyodide/WASM programs one private protocol for sending rich output to the dockable **Display** panel.

The first implementation is intentionally simple:

- one active display surface per workspace
- one active canvas for SDL/canvas-style rendering
- JSON messages from runtime to frontend
- basic keyboard and mouse event capture
- no full desktop GUI or `tkinter` compatibility

## Goals

- educational graphics
- turtle-style drawing layers
- matplotlib output
- pandas table output
- custom HTML/SVG/image rendering
- simple SDL / pygame-style canvas apps

## Protocol

Runtime code sends JSON messages to the frontend. Each message must contain a `type`.

Supported message types:

- `switch`
- `canvas`
- `svg`
- `image`
- `html`
- `table`
- `clear`
- `resize`
- `fullscreen`

## Message Types

### `switch`

Switches the browser UI to the Display tab.

```json
{
  "type": "switch",
  "focus": true,
  "message": "Display tab active"
}
```

Fields:

- `focus`: when `true`, focus moves to the display canvas
- `message`: optional status text for the Display toolbar

### `canvas`

Creates or reconfigures the active display canvas.

```json
{
  "type": "canvas",
  "width": 960,
  "height": 640,
  "background": "#ffffff",
  "bindSDL": false,
  "focus": true
}
```

Fields:

- `width`: canvas width in pixels
- `height`: canvas height in pixels
- `background`: CSS color
- `bindSDL`: when `true`, EdgeTerm binds the canvas to `pyodide.canvas.setCanvas2D(...)`
- `focus`: when `true`, focus moves to the canvas

### `svg`

Renders inline SVG markup.

```json
{
  "type": "svg",
  "content": "<svg viewBox='0 0 100 100'>...</svg>"
}
```

### `image`

Renders an image by URL or data URL.

```json
{
  "type": "image",
  "src": "data:image/png;base64,...",
  "alt": "Example image"
}
```

### `html`

Renders trusted HTML inside the Display panel.

```json
{
  "type": "html",
  "content": "<h1>Hello</h1><p>Rendered in EdgeTerm Display.</p>"
}
```

### `table`

Renders tabular data.

```json
{
  "type": "table",
  "columns": ["name", "score"],
  "rows": [
    {"name": "Ada", "score": 98},
    {"name": "Linus", "score": 91}
  ]
}
```

`rows` may be:

- a list of objects
- a list of lists

### `clear`

Clears the display.

```json
{
  "type": "clear",
  "message": "Display cleared"
}
```

### `resize`

Resizes the active display canvas.

```json
{
  "type": "resize",
  "width": 1280,
  "height": 720,
  "background": "#111827"
}
```

### `fullscreen`

Toggles fullscreen mode for the Display panel.

```json
{
  "type": "fullscreen",
  "enabled": true
}
```

## Python Usage

EdgeTerm ships a helper module at:

```python
import edgeterm_display as display
```

### Basic Examples

#### Clear the display

```python
import edgeterm_display as display

display.clear()
```

#### Switch to the Display tab

```python
import edgeterm_display as display

display.show()
```

Alias:

```python
display.switch_tab()
```

#### Show HTML

```python
import edgeterm_display as display

display.html("""
<div style="padding: 24px">
  <h1>EdgeTerm Display</h1>
  <p>Hello from Python.</p>
</div>
""")
```

#### Show SVG

```python
import edgeterm_display as display

display.svg("""
<svg viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="120" rx="18" fill="#0ea5e9"/>
  <circle cx="58" cy="60" r="24" fill="white"/>
  <text x="96" y="68" fill="white" font-size="22">EdgeTerm</text>
</svg>
""")
```

#### Show a table

```python
import edgeterm_display as display

display.table([
    {"language": "Python", "year": 1991},
    {"language": "JavaScript", "year": 1995},
])
```

## Pandas

Pandas DataFrames can be sent directly:

```python
import pandas as pd
import edgeterm_display as display

df = pd.DataFrame([
    {"name": "Ada", "score": 98},
    {"name": "Grace", "score": 95},
])

display.table(df)
```

## Matplotlib

For charts, render to SVG or PNG and send that output to the Display panel.

```python
import matplotlib.pyplot as plt
import edgeterm_display as display

plt.plot([1, 2, 3], [2, 5, 3])
plt.title("EdgeTerm Chart")

display.matplotlib_svg()
```

Or PNG:

```python
display.matplotlib_png()
```

## Turtle-Style Modules

EdgeTerm Display is the intended output surface for future browser-native turtle implementations.

Recommended pattern:

1. create a display canvas
2. draw on that canvas through JS/Python interop
3. keep drawing logic in Python and rendering in browser canvas

Example setup:

```python
import edgeterm_display as display

display.canvas(width=800, height=600, background="#ffffff")
```

## SDL / pygame-Style Programs

EdgeTerm can bind the Display canvas to the Pyodide runtime for SDL-based packages.

```python
import edgeterm_display as display

display.sdl_canvas(width=800, height=600, background="#000000")
```

That will:

- create the active Display canvas
- bind it through `pyodide.canvas.setCanvas2D(...)`
- focus the canvas so keyboard input can reach it

Pyodide SDL support is still subject to Pyodide’s browser/runtime constraints.

## Input Events

The Display panel collects a small input queue from the active canvas:

- `pointerdown`
- `pointermove`
- `pointerup`
- `wheel`
- `keydown`
- `keyup`

You can consume queued events from Python:

```python
import edgeterm_display as display

for event in display.events():
    print(event)
```

Each event is a simple object with fields such as:

- `type`
- `x`
- `y`
- `button`
- `buttons`
- `key`
- `code`
- `deltaX`
- `deltaY`
- `ts`

## Low-Level JS Bridge

Advanced programs may send raw messages directly:

```python
import js
import json

js.window.EdgeTermDisplay.send(json.dumps({
    "type": "html",
    "content": "<strong>Hello from raw protocol</strong>"
}))
```

## Recommended Usage by Module Type

- `turtle`: use `canvas`
- `matplotlib`: prefer `svg` or `image`
- `pandas`: use `table`
- custom dashboards: use `html`
- SDL / pygame-style apps: use `canvas` with `bindSDL`

## Notes

- The Display protocol is private to EdgeTerm Workspace and may evolve.
- HTML output is trusted workspace content, not sandboxed content.
- This is not a desktop windowing system.
- Only one active display canvas is managed per workspace in the current version.

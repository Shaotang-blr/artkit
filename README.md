# ArtKit

Physical drawing tools for drawing on any website canvas (built and tested for Karuta Studio).
A browser extension for Chrome / Edge / BrowserOS / any Chromium browser.

## Install (once)

1. Open `chrome://extensions` (BrowserOS: the same page).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `artkit` folder.
4. Open (or reload with F5) the drawing site. The ArtKit panel appears top-left; drag it by its
   title. Click the title (or `–` / `+`, or **Alt+A**) to minimise / open it.

After changing the code, click the reload arrow on ArtKit's card in `chrome://extensions`, then
reload the drawing page.

## Tools

| Tool | How to use |
|---|---|
| **Free** (Alt+1) | Normal drawing. **Shift+drag** still draws a straight line. |
| **Ruler** (Alt+2) | Drag from start to end: a dashed preview line follows the mouse, and on release a perfectly straight line is drawn. Snaps to 15° steps within 4° (hold **Alt** to switch snapping off/on for one line). Shows length and angle. |
| **Steady** (Alt+3) | Smooths hand shake: the pen follows your mouse on a "string" (circle shows its length, slider sets it). Wobbles smaller than the string never reach the canvas. |
| **Grid / Thirds / Centre** (Alt+G) | Guide lines over the canvas, never drawn on it. Grid spacing is in canvas pixels. |
| **Tracing paper** (Alt+T show/hide) | *Load picture…* lays a reference picture over the canvas, semi-transparent. *Move/size*: drag to move, mouse wheel to resize, click again when done. *Fit* covers the canvas. Only you see it: it's never drawn. |
| **🪣 Fill canvas** | Fills the whole canvas (or a box from **Set area**) with the colour and brush selected in the site, in the fewest strokes: flat rows with the biggest brush, 1 px overlap, row length a multiple of 3 px. **First select your colour and the site's BIGGEST brush**; set *brush* to its width (Karuta: 7). Tested: 274x405 canvas, 68 strokes of 2 points, 0 pixels missed; about **111 ink on Karuta** for a whole card. With *Set area* the round brush tips reach ~3 px past the box. Each row is one stroke, so undoing it takes 68 undos (Studio's X clears everything). |
| **Next canvas** | If the guides sit on the wrong canvas. (The canvas you press on is picked automatically.) |

## How it works

While a tool is on, ArtKit catches your mouse/pointer events on the canvas before the site sees
them, corrects the positions, and passes the corrected events on. The site draws exactly what it
would if your hand had moved that way.

- Ruler: press at the start, **no** movement events while dragging, then one move to the end and
  release: the site receives a 2-point stroke. On Karuta Studio that's also the cheapest possible
  line (ink = length of the saved path text).
- Settings are saved per website.

## Tested

`test/index.html` (a mouse-event app and a pointer-event app that record every point):
wobbly 60-point drag -> Ruler gives 2 points, 0 px off straight on both; Steady roughly halves the
wobble; real (trusted) mouse drags corrected too. Serve with `python -m http.server 8765` in this
folder and open `http://localhost:8765/test/index.html` (the page loads content.js itself).

## Next (planned)

Compass (circles/arcs), stencils (rectangle, ellipse, polygon, star, heart), protractor /
parallel lines, mirror drawing, Karuta colour picker, live ink meter.

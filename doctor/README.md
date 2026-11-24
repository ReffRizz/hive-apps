# HIVE Doctor

_By Jeff Robinson · JR TraceCode. © 2026 Jeff Robinson. All rights reserved._

An offline health reference: symptom check, medicine reference and interaction tracker, a 68-chapter medical book, picture atlas, report reader, graph builder and 3D body. Educational; not a diagnosis. The content has not yet been independently verified by a licensed clinician — a sign-off checklist is included for professional review.

## Start it
- **Windows:** double-click `START_HIVE_DOCTOR.cmd`. It serves this folder on your own computer only (nothing is installed, nothing leaves the machine) and opens the app in your browser.
- **Any computer with Python:** run `python -m http.server 8765` in this folder and open `http://localhost:8765/ai.html`.
- **Publishing:** upload the folder to any static web host. After the first visit the app keeps itself for offline use and can be installed to a phone's home screen.

Opening `ai.html` directly from the file manager does not work: browsers block the app from reading its own data files that way.

## What is inside
- `doctor_book.json` — the Book: chapters, glossary, condition articles, medicine reference.
- `figures.json` — original labelled diagrams. `photos.json` + `photos/` — example photographs with author and licence (`PHOTO_CREDITS.md`).
- `pills/` — package and label pictures from official US labels.
- `hive_med_safety.json` — the medicine tracker and interaction rules.
- `ocr/` — the bundled text reader used to scan photos of reports with no internet.

## Tests
`node run_all.js` runs every gate: REPCON, per-specialty board, report lab, teaching, graph, hardening, proofreading, picture fit and a real-browser smoke test (including emergencies, the focus-group questions and an offline check). After changing shipped files run `node build_sw.js` first.

## Sources and limits
- Medicine entries are verbatim excerpts from official US product labels (openFDA / DailyMed, US public domain), each with its label date and a link to the full label. Dosing text is reference only.
- Photographs are from Wikimedia Commons under free licences. CC BY and CC BY-SA images must keep their credit; see `PHOTO_CREDITS.md`.
- Chapter prose is original, written from standard clinical references. It has not been reviewed by a clinician.

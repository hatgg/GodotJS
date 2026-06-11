---
"@godot-js/editor": patch
---

**Feature:** Pre-transpile `.ts` sources via SWC at export time so exported builds need no `tsc`, and drop the hard `tsc`-install gate on the editor Start button.

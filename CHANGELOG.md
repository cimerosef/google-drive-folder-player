# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Planned

- Validate automatic next-track playback on Edge + Violentmonkey.
- Expand folder discovery beyond currently cached/rendered rows.
- Add shuffle.
- Add Repeat Off / All / One.
- Validate Chrome, Firefox, and Safari compatibility.

## [0.0.4] - 2026-09-13

### Added

- Identify Drive's native progress slider from the preview controls without relying on language-specific labels.
- Poll the progress slider and infer track end when playback reaches the end of the slider range.
- Add a continuous-playback prototype that automatically closes the current Drive preview and opens the next cached audio row.
- Add `Start continuous test`, `Next now`, and `Stop` controls plus a live playback-monitor status line.

### Findings

- Edge + Violentmonkey exposes a progress slider with a large numeric range (observed `0..1000`) and a separate volume slider (`0..100`), which gives the userscript a viable language-neutral route for playback progress and end detection.

## [0.0.3] - 2026-09-13

### Changed

- Keep folder scanning separate from an open Drive preview so the preview filename is not mistaken for the only folder item.
- Preserve the last successful folder scan when a preview is open.
- Automatically try to close an existing preview before opening the first cached track.
- Replace the inaccessible HTML-media test with a diagnostic probe of Drive's visible preview controls (buttons, sliders, progress bars, and time labels).

## [0.0.2] - 2026-09-13

### Findings

- Edge + Violentmonkey successfully opened Google Drive's native audio preview from a detected folder row.
- Drive's audio preview did not expose a directly accessible top-level HTML `audio` or `video` element to the userscript.
- A second DOM/UI control route is therefore required for playback-state and end-of-track detection.

## [0.0.1] - 2026-09-13

### Added

- Initial Google Drive folder probe.
- Detect visible audio items in the current Drive folder.
- Show detected filenames in an on-page diagnostic panel.
- Test opening the first detected audio item using the existing Drive interface.
- No privileged userscript APIs (`@grant none`).

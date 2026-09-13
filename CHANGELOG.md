# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Planned

- Identify a reliable DOM/UI route for playback state and track-end detection.
- Add continuous playback.
- Add shuffle.
- Add Repeat Off / All / One.
- Validate Chrome, Firefox, and Safari compatibility.

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

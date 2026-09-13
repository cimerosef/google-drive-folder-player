# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Planned

- Add Repeat Off / All / One.
- Expand folder discovery beyond currently cached/rendered rows.
- Validate Chrome, Firefox, and Safari compatibility.

## [0.0.11] - 2026-09-13

### Added

- Add an optional shuffled playback queue built with Fisher–Yates from the currently cached media items.
- Add a `Shuffle: ON/OFF` control and an amber queue preview showing the fixed playback order.
- Keep the active queue stable during playback; toggling Shuffle only affects the next Start.

### Findings

- Edge + Violentmonkey validation passed with the shuffled queue enabled.
- Repeated `Next now` actions followed the displayed randomized queue correctly.
- Automatic end-of-track advance also followed the next item in the same shuffled queue.
- MP3/WebM mixed-media playback remained functional.
- Transition responsiveness remained comparable to the validated 0.0.9/0.0.10 path.
- Shuffle itself introduces no repeats; Repeat remains a separate feature.

## [0.0.10] - 2026-09-13

### Added

- Integrate language-independent WebM/video progress detection using Drive's live hidden native `input[type="range"]` timeline.
- Preserve ordinary visible-slider progress detection for audio previews.

### Changed

- Avoid mistaking Google Drive's right-side Details/Information pane for an active media preview.
- Keep the 0.0.9 transition path and performance characteristics while supporting hidden WebM/video controls.

### Findings

- Edge + Violentmonkey confirmed MP3 -> WebM transition, hidden WebM progress tracking, WebM natural end detection, and automatic next-track playback.
- Keeping the right-side Details pane open no longer blocked preview transitions.
- The continuous-playback core is validated on Edge for currently discovered/cached media items.

## [0.0.9] - 2026-09-13

### Changed

- Keep the working 0.0.8 transition logic, but remove several conservative fixed waits that made first-track startup and next-track switching feel slow.
- Cache preview-open state once per folder scan instead of recomputing preview evidence for every candidate DOM node. This removes an expensive repeated full-page scan inside the folder-discovery loop.
- Reduce the post-close settle delay from a fixed 350 ms to an adaptive short wait, then let live-row resolution poll only as needed.
- Avoid `scrollIntoView()` and its follow-up delay when the target row is already comfortably inside the viewport.
- Shorten row-resolution and preview-confirmation polling intervals while preserving fallback retries for slower Drive transitions.
- Add scan and transition timing diagnostics so Edge tests can compare latency directly in milliseconds.

### Findings

- Edge + Violentmonkey on 0.0.9 kept repeated `Next now` transitions stable while making track changes noticeably faster.
- Observed successful transition timings were roughly 650–770 ms in the tested Drive folder.
- Automatic next-track playback was also confirmed on an MP3 by seeking near the end and letting the track finish naturally.
- The core playback chain is therefore validated on Edge for visible/cached items: scan -> open -> manual next -> repeated next -> end detection -> automatic next.
- Some WebM/video previews can still auto-hide the progress control, so their natural end-of-track detection remains a separate edge case to verify before shuffle/repeat are considered robust for mixed-media folders.

## [0.0.8] - 2026-09-13

### Changed

- Restore the broad folder-item discovery strategy that worked in 0.0.6: scan filename-bearing descendants (`span`, `aria-label`, `title`, etc.) and climb to their interactive Drive row/list/grid ancestor.
- Keep the preview-title detection introduced in 0.0.7, but do not require the filename itself to live directly on a `role=row`, `role=listitem`, or `role=gridcell` node.
- Continue excluding preview-header media text from folder scans while a preview is open.

### Findings

- 0.0.7 regressed folder scanning on the tested Edge/Drive layout: it returned `0 live row(s)` even though the same folder had produced 50 items in earlier probes.
- The regression came from restricting discovery to row/list/grid nodes themselves. On this Drive layout, the media filename is exposed on descendant elements, so the row's own text/accessible attributes are not reliable enough for discovery.

## [0.0.7] - 2026-09-13

### Changed

- Stop treating a visible progress slider as the only proof that a Drive preview is open.
- Detect the preview filename/title near the top of the Drive preview, so WebM/video previews can still be confirmed when their transport controls auto-hide.
- Allow progress-slider discovery even when Drive visually hides the controls but keeps the slider rendered in the DOM.
- Restrict folder discovery to Drive row/list/grid items instead of broadly scanning arbitrary page text.
- Keep the last eight transition diagnostics with timestamps instead of overwriting the diagnostic box, so short-lived failure messages remain visible.
- Extend preview-open confirmation time for slower media previews and record the last preview title seen before a timeout.

### Findings

- In 0.0.6, track 1 -> track 2 could visibly succeed, but the script could still report failure and keep its internal index at track 1.
- The failing target was a `.webm` item. A WebM/video preview can be visibly open while its playback controls (including the progress slider used by 0.0.6 as the open-state signal) are auto-hidden.
- This explains why subsequent `Next now` presses kept retrying track 2 even though track 2 was already playing.

## [0.0.6] - 2026-09-13

### Changed

- Reacquire the target Drive row from the live DOM after every preview close instead of trusting cached row elements from the initial scan.
- Reacquire the row again after `scrollIntoView`, because Drive virtualization can replace rows during scrolling.
- Preserve the previous playlist index when a transition fails, so another `Next now` retries the same track instead of silently skipping ahead.
- Retry one failed preview-open attempt with a freshly resolved row.
- Capture a Drive row identifier (`data-id` / `data-target`) when available and prefer it over filename matching.
- Add a short settle delay after closing the preview so Drive has time to rebuild the folder list.

### Findings

- Edge + Violentmonkey successfully transitioned from track 1 to track 2 in 0.0.5.
- Subsequent transitions failed with `Drive preview did not open`, while the script had already advanced its internal index. This strongly suggests cached Drive row elements become stale or are replaced after preview transitions / virtualization.

## [0.0.5] - 2026-09-13

### Changed

- Replace the synthetic `Escape` transition with a click on Drive's real visible preview close control before opening the next cached row.
- Add a language-independent geometric fallback for locating the top-left close control when its accessible label is unavailable.
- Add a `Probe transition` diagnostic showing the progress slider and the close-control candidate.
- Improve transition status messages so failures distinguish between close-control detection, ignored close clicks, stale cached rows, and preview-open failures.

### Findings

- `Next now` in 0.0.4 did not switch tracks on Edge; the first track continued playing.
- The most likely failure point is the synthetic Escape key event used to close Drive's preview. Script-generated keyboard events are not guaranteed to be treated like trusted user key presses by Drive.

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

# Edge + Violentmonkey WebM auto-next validation

Date: 2026-09-13

Environment:
- Microsoft Edge
- Violentmonkey
- Google Drive web UI
- Main script: Google Drive Folder Player Probe 0.0.9
- Integration probe: WebM Auto-Next Bridge 0.0.3

## Result

The integration path was validated successfully.

Observed sequence:
1. Folder scan succeeded and cached 50 visible media items.
2. Continuous playback started on track 1 (MP3).
3. `Next now` successfully closed the MP3 preview and opened track 2 (WebM) once the Google Drive details/info side panel was closed.
4. While the WebM played, the bridge detected Drive's hidden live `input[type=range]` timeline and mirrored its numeric progress into the 0.0.9 monitor path.
5. The main 0.0.9 script showed live WebM progress (example observed: 77.6%).
6. At WebM end, 0.0.9 inferred the track end and automatically advanced to track 3 (MP3).

## Important findings

- Drive's hidden WebM/video timeline remains live even after visible transport controls auto-hide.
- The native hidden range exposes language-independent numeric `value`, `min`, and `max` fields, so localized `aria-valuetext` is not required for end detection.
- A synthetic progress bridge can feed this signal into the existing 0.0.9 end-detection logic successfully.
- Google Drive's right-side details/info pane can retain the current filename after the real preview closes. The current 0.0.9 preview-title heuristic can mistake that pane for an open preview and block transitions. The integrated 0.0.10 implementation must explicitly exclude the details/info pane from preview-open detection.

## Next implementation step

Integrate the hidden native range detection directly into the dev main script as 0.0.10, remove the temporary bridge dependency, and harden preview-title detection so the Drive details/info side pane does not count as an open media preview.

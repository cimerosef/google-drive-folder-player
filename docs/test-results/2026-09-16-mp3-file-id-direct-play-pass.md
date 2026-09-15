# MP3 File-ID direct play probe — PASS

Date: 2026-09-16
Platform: Microsoft Edge + Violentmonkey
Branch: `dev/0.0.16-media-source-probe`

## Result

The MP3 File-ID Direct Play Probe successfully played a Google Drive MP3 without opening Drive Preview.

Validated path:

1. Single-click an MP3 row in the normal Drive file list.
2. Capture filename + stable Drive file ID at click time.
3. Construct a direct media URL using `drive.usercontent.google.com/download` with the current file ID, `confirm=t`, and the active Drive `authuser` index.
4. Load the URL into a separate HTML `Audio` element.
5. `loadedmetadata`, `loadeddata`, and `canplay` were observed with `readyState=4`.
6. `Play loaded candidate` successfully started audible MP3 playback.
7. No Drive Preview UI was present or required during playback.

## Important negative results

- `drive.google.com/uc?export=download&id=...` failed with media `errorCode=4`.
- `drive.usercontent.google.com/download?id=...&export=download&confirm=t` also failed with `errorCode=4`.
- Adding the active `authuser` value made the direct MP3 source load successfully.

## Conclusion

For MP3 files in the tested authenticated Drive session, a stable Drive file ID is sufficient to construct a directly playable media URL when the correct `authuser` index is included. This validates a possible future architecture that can use independent HTML Audio elements instead of repeatedly closing and reopening Drive Preview.

Next validation should be deliberately narrow: capture two MP3 file IDs, preload both with independent Audio elements, play track A, and verify track B can remain preloaded and start immediately when requested, including while the Drive tab is in the background.

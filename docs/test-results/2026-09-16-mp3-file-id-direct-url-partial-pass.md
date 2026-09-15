# MP3 File-ID direct URL probe — partial pass

Target: Edge + Violentmonkey

Date: 2026-09-16

## Result

The file-list probe successfully captured a stable Drive file ID from a clicked MP3 row without opening Drive Preview.

URL variants tested:

- `drive.google.com/uc?export=download&id=...` -> media element error (`errorCode=4`).
- `drive.usercontent.google.com/download?id=...&export=download&confirm=t` -> media element error (`errorCode=4`).
- `drive.usercontent.google.com/download?id=...&export=download&confirm=t&authuser=1` -> successful media load through `loadedmetadata`, `loadeddata`, and `canplay`; duration observed ~306.2 s and `readyState=4`.

## Interpretation

A stable Drive file ID plus the correct account index (`authuser`) and `confirm=t` is sufficient, in this observed session/account, to resolve an MP3 to a directly loadable HTMLAudioElement source without opening Drive Preview.

Playback itself still needs one final explicit validation by pressing the probe's `Play loaded candidate` button. Until that is confirmed, this is recorded as a partial pass rather than a full playback pass.

## Architectural consequence

If explicit playback succeeds, the project can pursue a direct-audio pipeline for MP3 files:

1. Capture stable Drive IDs from folder rows.
2. Build direct usercontent URLs using the current Drive account index.
3. Preload the next MP3 in a separate Audio element.
4. Transition without closing/opening Drive Preview.

This would remove the main source of background-tab transition delay for MP3 playback.

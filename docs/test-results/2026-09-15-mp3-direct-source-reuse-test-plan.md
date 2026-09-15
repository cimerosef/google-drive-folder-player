# MP3 direct-source reuse test plan

Target: Microsoft Edge + Violentmonkey

## Why this test exists

The Media Source Probe 0.0.1 showed a playing MP3 preview backed by a normal HTMLAudioElement whose `currentSrc` is a direct `https://drive.usercontent.google.com/download?...` URL. The element reported `readyState=4`, `networkState=1`, `paused=false`, a finite duration, `srcObject=none`, and the probe saw no MediaSource object URL.

This is promising because MP3 playback may be reusable outside Drive's preview UI. The next question is whether the exact source URL remains usable by a separate Audio element after the Drive preview is closed.

## Setup

- Disable the main folder-player script and all other probes.
- Enable only `probes/mp3-direct-source-reuse-probe.user.js` 0.0.1.
- Refresh Google Drive.
- Open a normal MP3 preview manually and let it play for a few seconds.

## Test

1. Click `1. Capture active source`.
2. Confirm the log reports a `drive.usercontent.google.com/download` source and does not print query values.
3. Click `2. Preload captured` while the Drive preview is still open.
4. Wait until the test log reaches at least `loadedmetadata` / `canplay`; `canplaythrough` is useful but not mandatory.
5. Manually pause or close the original Drive preview so only the separate test Audio can make sound.
6. Click `3. Play test copy`.
7. Listen for at least 15–30 seconds.
8. Confirm the test copy plays the same MP3 and continues without reopening the Drive preview.
9. If convenient, switch to another browser tab for 15–30 seconds and confirm the test copy keeps playing.

## Success criteria

A strong pass is:

- source capture succeeds;
- the separate test Audio reaches a playable ready state;
- buffered ranges appear;
- `play()` resolves after the Drive preview is closed;
- the same MP3 audibly plays from the separate Audio element;
- no Drive preview reopening is required.

## Interpretation

If this passes, the current MP3 media URL itself is reusable and Drive preview UI is not required once that URL has been obtained. This would justify a second probe aimed at obtaining a usable source URL for a queued file before opening its preview, which is the key requirement for true next-track preloading.

If exact-URL reuse fails after preview closure, the direct URL is likely session/preview-coupled or otherwise short-lived, and a custom-player architecture would need a different source-acquisition path.

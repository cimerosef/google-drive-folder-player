# MP3 direct-source reuse — PASS

Date: 2026-09-15

Platform: Microsoft Edge + Violentmonkey

## Test

Using `probes/mp3-direct-source-reuse-probe.user.js`:

1. Opened an MP3 in the normal Google Drive Preview.
2. Captured the active Preview audio source (`drive.usercontent.google.com/download?...`).
3. Loaded the captured source into the probe's own `Audio` element.
4. Closed the normal Google Drive Preview.
5. Clicked `Play test copy`.

## Result

PASS.

The same MP3 restarted and played from the probe-owned audio element even though the Google Drive Preview interface was no longer open.

## Interpretation

This proves that, for the tested MP3 path, playback itself is not dependent on keeping the Drive Preview UI alive. The Preview exposes a normal HTTPS media source that remains usable by a separate `HTMLAudioElement` after Preview closure.

This is a major architectural result: a future player may be able to keep playback in its own audio element and avoid the slow `close Preview -> open next Preview -> wait for Preview UI` transition path.

The next unknown is source discovery: can a usable media URL be obtained from a Drive file row / stable file ID without opening Preview for that file? The next probe should test direct-by-file-ID playback while no Preview is open.
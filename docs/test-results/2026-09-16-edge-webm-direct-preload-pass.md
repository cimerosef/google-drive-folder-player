# Edge + Violentmonkey — WebM direct preload PASS

Date: 2026-09-16

## Result

The WebM direct-media path is validated without Google Drive Preview.

Observed in the two-track preload probe:

- Two WebM files were captured from ordinary Drive rows with stable Drive IDs.
- Both direct usercontent URLs loaded successfully with the active `authuser` index.
- Both media elements reached `loadedmetadata`, `loadeddata`, `canplay`, and `canplaythrough`.
- Foreground natural A -> B handoff succeeded smoothly.
- Measured foreground audible-start latency was about 17 ms in one run.
- Background-tab A -> B handoff also succeeded: B started automatically and continued playing normally while the Drive tab was hidden.
- Measured background audible-start latency was about 2 ms in the reported run.
- No Google Drive Preview was required.

## Conclusion

WebM has now passed the same essential direct-playback and preload validations as MP3. The next integration step can therefore replace the WebM Preview fallback with the same direct-media/preload architecture, while preserving the existing queue, Shuffle, Repeat, draggable panel, and current rendered-row scan limitation.

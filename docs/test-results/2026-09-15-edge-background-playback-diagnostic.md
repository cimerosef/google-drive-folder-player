# Edge background playback diagnostic — 0.0.13

Target: Microsoft Edge + Violentmonkey

Observed with main player 0.0.13 plus Background Playback Probe 0.0.2.

## Reproduction

- Start a 50-item cached playlist.
- Put the Google Drive tab in the background while track 1 plays.
- Let track 1 finish naturally.

## Probe evidence

The background probe captured the following sequence while the Drive tab remained hidden:

- Progress reached 80%.
- Progress reached 90%.
- Progress crossed 99%.
- Main player reported `End detected. Advancing to 2/50…`.
- Progress reached 100%.
- Main player later reported `Transition blocked: Drive ignored the scripted close-button click.`

This means the end-of-track detector and background timer were sufficiently active to detect the natural end. The failure happened during the transition path, specifically while waiting for Drive's current preview to close before opening the next queue item.

## Important interpretation

The existing error text says Drive "ignored" the scripted close click, but the diagnostic only proves that the 0.0.13 close-confirmation loop did not observe the preview as closed within its retry window. In a hidden/background tab, Drive may delay UI/DOM state updates, so this message may be a false diagnosis rather than proof that the click itself was rejected.

The screenshot taken after returning to the tab showed the folder list rather than the active preview, which is consistent with the close action eventually taking effect after the main player had already aborted the transition.

## Conclusion

Background-playback reliability is currently blocked by preview-close confirmation / transition handling, not by end detection.

Next experiment should change only the background transition path while preserving the validated 0.0.13 foreground behavior. Candidate strategy: when the tab is hidden and close confirmation is delayed, avoid immediately aborting the transition; attempt a narrowly scoped background fallback and accept it only if the requested next preview is positively confirmed.

# Google Drive Folder Player

A lightweight userscript that adds folder-based audio playback controls to the Google Drive web interface.

## Goals

- Play audio files from the current Google Drive folder.
- Continuous playback without downloading or syncing the folder locally.
- Shuffle playback.
- Repeat modes: Off, All, and One.
- One codebase for Edge, Chrome, Firefox, and Safari.
- Compatible with standard userscript managers such as Violentmonkey and Userscripts.
- No Google Drive API, OAuth client, API key, third-party server, analytics, or tracking.
- Prefer standard browser DOM APIs only; keep `@grant none` whenever possible.

## Development strategy

The project is private while experimental. Edge + Violentmonkey is the first validation platform. Once the core behavior is stable, the same script will be validated on Chrome, Firefox, and Safari + Userscripts.

Current development stages:

1. `0.0.1` Probe: detect audio items in the current Drive folder and test opening one item.
2. Probe playback state and end-of-track detection.
3. Continuous playback.
4. Shuffle.
5. Repeat Off / All / One.
6. Cross-browser validation.
7. Public `1.0.0` release.

## Current status

Experimental. Do not publish or distribute yet.

## Repository policy

GitHub Actions and Codespaces are intentionally not used during the private development phase. The repository is used only for source control, history, issues, and manual browser testing.

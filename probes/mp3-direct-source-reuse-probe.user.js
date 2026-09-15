// ==UserScript==
// @name         Google Drive Folder Player - MP3 Direct Source Reuse Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Test whether an MP3 source exposed by Google Drive preview can be preloaded and replayed by a separate HTMLAudioElement after the Drive preview is closed.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-mp3-reuse-probe';

  let capturedSrc = '';
  let testAudio = null;
  let lines = [];

  function stamp() {
    return new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function sanitizeUrl(value) {
    const text = String(value || '');
    if (!text) return '(none)';
    try {
      const url = new URL(text, location.href);
      const keys = [...new Set([...url.searchParams.keys()])];
      return `${url.origin}${url.pathname}${keys.length ? `?<keys:${keys.join(',')}>` : ''}`;
    } catch {
      return text.slice(0, 220);
    }
  }

  function log(message) {
    lines.push(`${stamp()}  ${message}`);
    lines = lines.slice(-80);
    const box = document.querySelector(`#${PANEL_ID} [data-role="log"]`);
    if (box) box.textContent = lines.join('\n');
    console.log('[GDFP MP3 Reuse Probe]', message);
  }

  function findActiveDriveAudio() {
    const audios = [...document.querySelectorAll('audio')];
    const scored = audios
      .map(audio => ({
        audio,
        src: audio.currentSrc || audio.src || '',
        score:
          (!audio.paused ? 100 : 0) +
          (audio.readyState >= 2 ? 20 : 0) +
          ((audio.currentSrc || audio.src || '').includes('drive.usercontent.google.com') ? 50 : 0)
      }))
      .filter(item => item.src)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.audio || null;
  }

  function bufferedSummary(audio) {
    if (!audio?.buffered) return '(none)';
    const parts = [];
    for (let i = 0; i < audio.buffered.length; i += 1) {
      parts.push(`${audio.buffered.start(i).toFixed(1)}-${audio.buffered.end(i).toFixed(1)}`);
    }
    return parts.length ? parts.join(', ') : '(empty)';
  }

  function captureActiveSource() {
    const audio = findActiveDriveAudio();
    if (!audio) {
      log('Capture failed: no active Drive audio element with a source was found.');
      return;
    }

    capturedSrc = audio.currentSrc || audio.src || '';
    log(
      `Captured active source: ${sanitizeUrl(capturedSrc)} | ready=${audio.readyState} paused=${audio.paused} t=${audio.currentTime.toFixed(1)}/${Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : 'n/a'}`
    );
  }

  function ensureTestAudio() {
    if (!capturedSrc) {
      log('No captured source yet. Open an MP3 preview and click Capture active source first.');
      return null;
    }

    if (testAudio && testAudio.src === capturedSrc) return testAudio;

    if (testAudio) {
      try {
        testAudio.pause();
        testAudio.removeAttribute('src');
        testAudio.load();
      } catch {
        // Ignore cleanup races.
      }
    }

    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = capturedSrc;
    testAudio = audio;

    const events = [
      'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
      'playing', 'waiting', 'stalled', 'suspend', 'ended', 'error'
    ];

    for (const eventName of events) {
      audio.addEventListener(eventName, () => {
        const error = audio.error ? ` errorCode=${audio.error.code}` : '';
        log(
          `TEST ${eventName}: ready=${audio.readyState} network=${audio.networkState} paused=${audio.paused} t=${audio.currentTime.toFixed(1)}/${Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : 'n/a'} buffered=${bufferedSummary(audio)}${error}`
        );
      });
    }

    audio.addEventListener('progress', () => {
      log(`TEST progress: buffered=${bufferedSummary(audio)}`);
    });

    return audio;
  }

  function preloadCaptured() {
    const audio = ensureTestAudio();
    if (!audio) return;
    log('Preload requested for captured source. The Drive preview is not modified.');
    audio.load();
  }

  async function playTestCopy() {
    const audio = ensureTestAudio();
    if (!audio) return;
    try {
      await audio.play();
      log(`TEST play() resolved. buffered=${bufferedSummary(audio)}`);
    } catch (error) {
      log(`TEST play() rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
    }
  }

  function pauseTestCopy() {
    if (!testAudio) {
      log('No test audio exists yet.');
      return;
    }
    testAudio.pause();
    log(`TEST paused at ${testAudio.currentTime.toFixed(1)} s.`);
  }

  function resetTest() {
    if (testAudio) {
      try {
        testAudio.pause();
        testAudio.removeAttribute('src');
        testAudio.load();
      } catch {
        // Ignore cleanup races.
      }
    }
    testAudio = null;
    capturedSrc = '';
    lines = [];
    log(`Reset complete. Probe ${VERSION} ready.`);
  }

  function makeButton(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      border: '1px solid rgba(255,255,255,.25)',
      borderRadius: '6px',
      padding: '6px 8px',
      background: 'rgba(255,255,255,.10)',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit'
    });
    button.addEventListener('click', handler);
    return button;
  }

  function mount() {
    if (!document.body || document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: '520px',
      maxHeight: '55vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '10px',
      borderRadius: '10px',
      background: 'rgba(25,27,30,.96)',
      color: '#f1f3f4',
      border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 22px rgba(0,0,0,.30)',
      font: '11px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `MP3 Direct Source Reuse Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'Open one MP3 in Drive. Capture its active source, preload a separate Audio element, then manually close the Drive preview and click Play test copy. Query values are never printed.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '7px';

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '6px',
      flexWrap: 'wrap',
      marginBottom: '8px'
    });
    controls.append(
      makeButton('1. Capture active source', captureActiveSource),
      makeButton('2. Preload captured', preloadCaptured),
      makeButton('3. Play test copy', playTestCopy),
      makeButton('Pause test copy', pauseTestCopy),
      makeButton('Reset', resetTest)
    );

    const logBox = document.createElement('div');
    logBox.dataset.role = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere'
    });

    panel.append(title, note, controls, logBox);
    document.body.appendChild(panel);
    log(`Probe ${VERSION} ready.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mount();
  }

  init();
})();

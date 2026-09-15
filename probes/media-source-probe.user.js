// ==UserScript==
// @name         Google Drive Folder Player - Media Source Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Passive-ish diagnostics for Google Drive preview media plumbing: media elements, MediaSource, shadow roots, iframes, and candidate resource URLs.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-media-source-probe';
  const STORAGE_KEY = 'gdfp-media-source-probe-log-v1';
  const MAX_LINES = 220;
  const SNAPSHOT_INTERVAL_MS = 1500;

  const lines = loadLines();
  const seenMedia = new WeakSet();
  const seenFrames = new WeakSet();
  const seenRoots = new WeakSet();
  const seenResources = new Set();
  const sourceBufferCounts = new WeakMap();

  let mediaCount = 0;
  let frameCount = 0;
  let shadowCount = 0;
  let candidateResourceCount = 0;
  let mseCount = 0;
  let panelMounted = false;

  const nativeCreateObjectURL = URL.createObjectURL?.bind(URL);
  const nativeAttachShadow = Element.prototype.attachShadow;
  const nativePlay = HTMLMediaElement.prototype.play;
  const nativeAddSourceBuffer = window.MediaSource?.prototype?.addSourceBuffer;
  const nativeAppendBuffer = window.SourceBuffer?.prototype?.appendBuffer;

  function nowStamp() {
    const d = new Date();
    return d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function loadLines() {
    try {
      const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value.slice(-MAX_LINES) : [];
    } catch {
      return [];
    }
  }

  function saveLines() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(lines.slice(-MAX_LINES)));
    } catch {
      // Diagnostics should not affect Drive.
    }
  }

  function log(message) {
    const line = `${nowStamp()}  ${message}`;
    lines.push(line);
    while (lines.length > MAX_LINES) lines.shift();
    saveLines();
    render();
    console.log('[GDFP Media Source Probe]', message);
  }

  function clearLog() {
    lines.length = 0;
    seenResources.clear();
    saveLines();
    log(`Log cleared. Probe ${VERSION} active.`);
  }

  function sanitizeUrl(value) {
    const text = String(value || '');
    if (!text) return '(none)';
    if (text.startsWith('blob:')) return 'blob:<redacted>';
    if (text.startsWith('data:')) {
      const comma = text.indexOf(',');
      return comma >= 0 ? `${text.slice(0, Math.min(comma, 80))},<redacted>` : 'data:<redacted>';
    }

    try {
      const url = new URL(text, location.href);
      const keys = [...new Set([...url.searchParams.keys()])].slice(0, 8);
      const query = keys.length ? `?<keys:${keys.join(',')}>` : '';
      let path = url.pathname || '/';
      if (path.length > 180) path = `${path.slice(0, 90)}…${path.slice(-70)}`;
      return `${url.origin}${path}${query}`;
    } catch {
      return text.length > 220 ? `${text.slice(0, 200)}…` : text;
    }
  }

  function mediaSummary(media) {
    const tag = media.tagName?.toLowerCase?.() || 'media';
    const src = sanitizeUrl(media.currentSrc || media.src || '');
    const duration = Number.isFinite(media.duration) ? media.duration.toFixed(1) : 'n/a';
    const time = Number.isFinite(media.currentTime) ? media.currentTime.toFixed(1) : 'n/a';
    const ready = media.readyState;
    const network = media.networkState;
    const paused = media.paused;
    const srcObject = media.srcObject ? media.srcObject.constructor?.name || 'present' : 'none';
    return `${tag} src=${src} ready=${ready} network=${network} paused=${paused} t=${time}/${duration} srcObject=${srcObject}`;
  }

  function observeMedia(media, context = 'document') {
    if (!(media instanceof HTMLMediaElement)) return;

    if (!seenMedia.has(media)) {
      seenMedia.add(media);
      mediaCount += 1;
      log(`MEDIA discovered in ${context}: ${mediaSummary(media)}`);

      const events = [
        'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing',
        'waiting', 'stalled', 'suspend', 'ended', 'error', 'encrypted'
      ];
      for (const eventName of events) {
        media.addEventListener(eventName, () => {
          const error = media.error ? ` errorCode=${media.error.code}` : '';
          log(`MEDIA event ${eventName}: ${mediaSummary(media)}${error}`);
        }, { passive: true });
      }
    }
  }

  function inspectFrame(frame) {
    if (!(frame instanceof HTMLIFrameElement)) return;

    if (!seenFrames.has(frame)) {
      seenFrames.add(frame);
      frameCount += 1;
      log(`IFRAME discovered: src=${sanitizeUrl(frame.src || frame.getAttribute('src') || '')}`);
      frame.addEventListener('load', () => inspectFrame(frame), { passive: true });
    }

    try {
      const doc = frame.contentDocument;
      if (!doc) {
        log(`IFRAME not currently readable: ${sanitizeUrl(frame.src || '')}`);
        return;
      }
      registerRoot(doc, `iframe:${sanitizeUrl(frame.src || '(same document)')}`);
    } catch {
      log(`IFRAME cross-origin/inaccessible: ${sanitizeUrl(frame.src || '')}`);
    }
  }

  function scanRoot(root, context) {
    try {
      const media = root.querySelectorAll?.('audio, video') || [];
      for (const element of media) observeMedia(element, context);

      const frames = root.querySelectorAll?.('iframe') || [];
      for (const frame of frames) inspectFrame(frame);
    } catch {
      // Ignore inaccessible roots.
    }
  }

  function registerRoot(root, context = 'root') {
    if (!root || seenRoots.has(root)) return;
    seenRoots.add(root);

    if (root instanceof ShadowRoot) {
      shadowCount += 1;
      log(`SHADOW root registered: ${context}`);
    }

    scanRoot(root, context);

    try {
      const observer = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node instanceof HTMLMediaElement) observeMedia(node, context);
            if (node instanceof HTMLIFrameElement) inspectFrame(node);
            scanRoot(node, context);
            if (node.shadowRoot) registerRoot(node.shadowRoot, `open-shadow:${node.tagName.toLowerCase()}`);
          }
        }
      });
      observer.observe(root, { childList: true, subtree: true });
    } catch {
      // Some roots may not be observable.
    }
  }

  function installAttachShadowHook() {
    if (typeof nativeAttachShadow !== 'function') return;

    Element.prototype.attachShadow = function(init) {
      const root = nativeAttachShadow.call(this, init);
      const mode = init?.mode || 'unknown';
      registerRoot(root, `${mode}-shadow:${this.tagName?.toLowerCase?.() || 'element'}`);
      return root;
    };
    log('HOOK attachShadow installed.');
  }

  function installCreateObjectURLHook() {
    if (typeof nativeCreateObjectURL !== 'function') return;

    URL.createObjectURL = function(object) {
      const result = nativeCreateObjectURL(object);
      let kind = object?.constructor?.name || typeof object;
      let details = '';

      if (typeof MediaSource !== 'undefined' && object instanceof MediaSource) {
        kind = 'MediaSource';
        mseCount += 1;
        details = ` readyState=${object.readyState}`;
      } else if (object instanceof Blob) {
        details = ` type=${object.type || '(none)'} size=${object.size}`;
      }

      log(`createObjectURL(${kind}${details}) -> blob:<redacted>`);
      return result;
    };
    log('HOOK createObjectURL installed.');
  }

  function installMediaElementPlayHook() {
    if (typeof nativePlay !== 'function') return;

    HTMLMediaElement.prototype.play = function(...args) {
      observeMedia(this, 'play() hook');
      log(`MEDIA play() called: ${mediaSummary(this)}`);
      return nativePlay.apply(this, args);
    };
    log('HOOK HTMLMediaElement.play installed.');
  }

  function installMediaSourceHooks() {
    if (typeof nativeAddSourceBuffer === 'function') {
      MediaSource.prototype.addSourceBuffer = function(type) {
        log(`MSE addSourceBuffer: ${String(type || '(empty)')}`);
        return nativeAddSourceBuffer.call(this, type);
      };
      log('HOOK MediaSource.addSourceBuffer installed.');
    }

    if (typeof nativeAppendBuffer === 'function') {
      SourceBuffer.prototype.appendBuffer = function(data) {
        const count = (sourceBufferCounts.get(this) || 0) + 1;
        sourceBufferCounts.set(this, count);
        if (count === 1 || count % 25 === 0) {
          const bytes = data?.byteLength ?? data?.length ?? 'n/a';
          log(`MSE appendBuffer #${count}: ${bytes} byte(s)`);
        }
        return nativeAppendBuffer.call(this, data);
      };
      log('HOOK SourceBuffer.appendBuffer installed.');
    }
  }

  function isCandidateResource(entry) {
    const name = String(entry?.name || '');
    const lower = name.toLowerCase();
    const type = String(entry?.initiatorType || '').toLowerCase();

    if (['audio', 'video', 'media'].includes(type)) return true;
    if (/videoplayback|googlevideo\.com|docs\.googleusercontent\.com|drive\.google\.com\/uc|download/.test(lower)) return true;

    if (/googleusercontent\.com/.test(lower)) {
      const size = Number(entry.transferSize || entry.encodedBodySize || 0);
      return size > 128 * 1024;
    }

    return false;
  }

  function considerResource(entry) {
    if (!isCandidateResource(entry)) return;
    const url = sanitizeUrl(entry.name);
    const key = `${entry.initiatorType}|${url}`;
    if (seenResources.has(key)) return;
    seenResources.add(key);
    candidateResourceCount += 1;

    const transfer = Math.round(Number(entry.transferSize || 0) / 1024);
    const body = Math.round(Number(entry.encodedBodySize || 0) / 1024);
    const duration = Math.round(Number(entry.duration || 0));
    log(`RESOURCE candidate: init=${entry.initiatorType || '(none)'} transfer=${transfer}KB body=${body}KB duration=${duration}ms url=${url}`);
  }

  function installPerformanceObserver() {
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) considerResource(entry);
      });
      observer.observe({ type: 'resource', buffered: true });
      log('PerformanceObserver(resource) installed.');
    } catch {
      log('PerformanceObserver(resource) unavailable.');
    }
  }

  function scanPerformanceEntries() {
    try {
      for (const entry of performance.getEntriesByType('resource')) considerResource(entry);
    } catch {
      // Ignore.
    }
  }

  function scanKnownOpenShadowRoots(root = document) {
    try {
      const all = root.querySelectorAll?.('*') || [];
      for (const element of all) {
        if (element.shadowRoot) {
          registerRoot(element.shadowRoot, `open-shadow:${element.tagName.toLowerCase()}`);
        }
      }
    } catch {
      // Ignore.
    }
  }

  function snapshot(reason = 'manual') {
    registerRoot(document, 'top-document');
    scanRoot(document, 'top-document');
    scanKnownOpenShadowRoots(document);
    scanPerformanceEntries();

    for (const media of document.querySelectorAll('audio, video')) {
      observeMedia(media, 'top-document');
      log(`SNAPSHOT media: ${mediaSummary(media)}`);
    }

    try {
      const metadata = navigator.mediaSession?.metadata;
      if (metadata) {
        log(`MEDIA SESSION: title=${metadata.title || '(none)'} artist=${metadata.artist || '(none)'} album=${metadata.album || '(none)'}`);
      }
    } catch {
      // Ignore.
    }

    log(`SNAPSHOT ${reason}: media=${mediaCount} iframe=${frameCount} shadow=${shadowCount} MSE-objectURL=${mseCount} resourceCandidates=${candidateResourceCount}.`);
  }

  function render() {
    if (!panelMounted) return;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const summary = panel.querySelector('[data-gdfp-media="summary"]');
    const logBox = panel.querySelector('[data-gdfp-media="log"]');
    if (summary) {
      summary.textContent = `media ${mediaCount} · iframe ${frameCount} · shadow ${shadowCount} · MSE ${mseCount} · resource candidates ${candidateResourceCount}`;
    }
    if (logBox) logBox.textContent = lines.slice(-42).join('\n');
  }

  function makeButton(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      padding: '5px 8px',
      borderRadius: '6px',
      border: '1px solid rgba(255,255,255,.25)',
      background: 'rgba(255,255,255,.1)',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit'
    });
    button.addEventListener('click', handler);
    return button;
  }

  function mountPanel() {
    if (!document.body || document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: '560px',
      maxHeight: '56vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '10px',
      borderRadius: '10px',
      background: 'rgba(25,27,30,.96)',
      color: '#f1f3f4',
      border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 22px rgba(0,0,0,.3)',
      font: '11px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `Media Source Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'Diagnostic only. Open one MP3 preview, then one WebM preview. URLs are sanitized: query values are never shown.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '7px';

    const summary = document.createElement('div');
    summary.dataset.gdfpMedia = 'summary';
    summary.style.marginBottom = '7px';

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '6px',
      flexWrap: 'wrap',
      marginBottom: '7px'
    });

    const copyButton = makeButton('Copy report', async () => {
      const text = lines.join('\n');
      try {
        await navigator.clipboard.writeText(text);
        log('Report copied to clipboard.');
      } catch {
        log('Clipboard write failed; use screenshot or console instead.');
      }
    });

    controls.append(
      makeButton('Snapshot now', () => snapshot('button')),
      makeButton('Clear log', clearLog),
      copyButton
    );

    const logBox = document.createElement('div');
    logBox.dataset.gdfpMedia = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere'
    });

    panel.append(title, note, summary, controls, logBox);
    document.body.appendChild(panel);
    panelMounted = true;
    render();
  }

  function lateInit() {
    if (!document.documentElement) {
      setTimeout(lateInit, 50);
      return;
    }

    registerRoot(document, 'top-document');

    const mountWhenReady = () => {
      if (!document.body) {
        setTimeout(mountWhenReady, 50);
        return;
      }
      mountPanel();
      snapshot('initial');
      setInterval(() => snapshot('periodic'), SNAPSHOT_INTERVAL_MS);
    };

    mountWhenReady();
  }

  installAttachShadowHook();
  installCreateObjectURLHook();
  installMediaElementPlayHook();
  installMediaSourceHooks();
  installPerformanceObserver();
  lateInit();
})();

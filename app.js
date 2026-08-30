/**
 * OD-11 speaker control — talks to the speaker's WebSocket directly from the browser.
 * Protocol mirrors OD11-remote's speaker.js: join, keepalive ping, volume delta, playback toggle.
 * The speaker IP is kept only in localStorage on this machine.
 */

const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 5000;
const STORAGE_KEY = 'od11-webapp:ip';

const els = {
  setup: document.getElementById('setup'),
  controls: document.getElementById('controls'),
  ipInput: document.getElementById('ip'),
  connectBtn: document.getElementById('connect'),
  disconnectBtn: document.getElementById('disconnect'),
  status: document.getElementById('status'),
  volume: document.getElementById('volume'),
  volumeValue: document.getElementById('volumeValue'),
  playpause: document.getElementById('playpause'),
};

let socket = null;
let pingInterval = null;
let reconnectTimeout = null;
let dragging = false;

let currentVolume = 0;
let maxVolume = 100;
let isPlaying = false;
let sourcesMap = {};
let currentSourceId = null;

function setStatus(text) {
  els.status.textContent = text;
}

function setControlsEnabled(enabled) {
  els.volume.disabled = !enabled;
  els.playpause.disabled = !enabled;
}

function connect(ip) {
  clearTimeout(reconnectTimeout);
  setStatus('Connecting…');
  setControlsEnabled(false);

  socket = new WebSocket(`ws://${ip}/ws`);
  const uid = 'uid-' + Math.floor(1e8 * Math.random());

  socket.addEventListener('open', () => {
    setStatus('Connected');
    setControlsEnabled(true);

    socket.send(JSON.stringify({
      protocol_major_version: 0,
      protocol_minor_version: 4,
      action: 'global_join',
    }));
    socket.send(JSON.stringify({
      color_index: 0,
      name: 'od11-webapp',
      realtime_data: true,
      uid,
      action: 'group_join',
    }));

    pingInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          value: Date.now() % 1e6,
          action: 'speaker_ping',
        }));
      }
    }, PING_INTERVAL_MS);
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    const items = Array.isArray(msg) ? msg : [msg];
    for (const item of items) {
      if (item && item.update) parseUpdate(item);
      if (item && Array.isArray(item.sources)) {
        for (const src of item.sources) {
          if (src && typeof src.id === 'number') sourcesMap[src.id] = src;
        }
      }
      if (item && Array.isArray(item.state)) {
        for (const stateItem of item.state) {
          if (stateItem && stateItem.update) parseUpdate(stateItem);
        }
      }
    }
  });

  socket.addEventListener('error', () => {
    setStatus('Connection error');
  });

  socket.addEventListener('close', () => {
    setStatus('Disconnected — reconnecting…');
    setControlsEnabled(false);
    clearInterval(pingInterval);
    pingInterval = null;
    reconnectTimeout = setTimeout(() => connect(ip), RECONNECT_DELAY_MS);
  });
}

function parseUpdate(item) {
  if (item.update === 'group_max_volume' && typeof item.value === 'number') {
    maxVolume = item.value;
    els.volume.max = String(maxVolume);
  }
  if (item.update === 'group_volume_changed' && typeof item.vol === 'number') {
    currentVolume = item.vol;
    if (!dragging) renderVolume();
  }
  if (item.update === 'playback_state_changed' && typeof item.playing === 'boolean') {
    isPlaying = item.playing;
    renderPlayback();
  }
  if (item.update === 'group_input_source_changed' && typeof item.source === 'number') {
    currentSourceId = item.source;
  }
}

function renderVolume() {
  els.volume.value = String(currentVolume);
  els.volumeValue.textContent = `${currentVolume} / ${maxVolume}`;
}

function renderPlayback() {
  els.playpause.textContent = isPlaying ? '⏸ Pause' : '▶︎ Play';
}

function sendVolumeDelta(newValue) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const amount = newValue - currentVolume;
  if (amount === 0) return;
  socket.send(JSON.stringify({ amount, action: 'group_change_volume' }));
}

function canCurrentSourcePause() {
  const src = currentSourceId !== null ? sourcesMap[currentSourceId] : null;
  return src ? src.supports_pause !== false : true;
}

function togglePlayPause() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!canCurrentSourcePause()) return;
  const newPlaying = !isPlaying;
  socket.send(JSON.stringify({ action: newPlaying ? 'playback_start' : 'playback_stop' }));
  isPlaying = newPlaying;
  renderPlayback();
}

// ── UI wiring ────────────────────────────────────────────────────────────

els.ipInput.value = localStorage.getItem(STORAGE_KEY) || '';

els.connectBtn.addEventListener('click', () => {
  const ip = els.ipInput.value.trim();
  if (!ip) return;
  localStorage.setItem(STORAGE_KEY, ip);
  els.setup.classList.add('hidden');
  els.controls.classList.remove('hidden');
  connect(ip);
});

els.disconnectBtn.addEventListener('click', () => {
  clearTimeout(reconnectTimeout);
  clearInterval(pingInterval);
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  els.controls.classList.add('hidden');
  els.setup.classList.remove('hidden');
});

els.volume.addEventListener('mousedown', () => { dragging = true; });
els.volume.addEventListener('touchstart', () => { dragging = true; });

els.volume.addEventListener('input', () => {
  els.volumeValue.textContent = `${els.volume.value} / ${maxVolume}`;
});

els.volume.addEventListener('change', () => {
  sendVolumeDelta(Number(els.volume.value));
  dragging = false;
});

els.playpause.addEventListener('click', togglePlayPause);

// Auto-connect if we already have a saved IP.
const savedIp = localStorage.getItem(STORAGE_KEY);
if (savedIp) {
  els.setup.classList.add('hidden');
  els.controls.classList.remove('hidden');
  connect(savedIp);
}

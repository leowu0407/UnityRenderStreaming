/**
 * LatencyMeasurer – measures End-to-End latency AND 4 sub-segments.
 *
 * Measurement points:
 *   t1      = client performance.now() at keydown
 *   t1_wall = client Date.now() at keydown  (PTP wall clock)
 *   t2_srv  = server realtimeSinceStartup ms at probe arrival
 *   t2_ptp  = server PTP wall clock ms at probe arrival
 *   t3_ptp  = server PTP wall clock ms at encode (embedded in frame by EmbbEncodeTimestamper)
 *   t4_perf = client performance.now() when encoded frame received (Worker)
 *   t4_wall = client Date.now() when encoded frame received (Worker, PTP)
 *   t5      = client expectedDisplayTime (red frame displayed)
 *
 * Segments:
 *   URLLC TX      = t2_ptp - t1_wall          (PTP cross-VM, ±200µs)
 *   Server        = t3_ptp - t2_ptp            (same server wall clock, no PTP error)
 *   eMBB TX       = t4_wall - t3_ptp           (PTP cross-VM, ±200µs)
 *   Client decode = t5 - t4_perf               (same machine, <1ms)
 *
 * Completion: requires ACK (t2_ptp) + eMBB frame stamp (t3_ptp, t4) + red frame (t5).
 *
 * PACKET FORMATS:
 *   Probe (Client→Server, 13 bytes):
 *     [0]     0x10
 *     [1-4]   uint32  seqNo (LE)
 *     [5-12]  float64 t1_ms (LE)  performance.now() at keydown
 *
 *   ACK (Server→Client, 37 bytes):
 *     [0]     0x11
 *     [1-4]   uint32  seqNo
 *     [5-12]  float64 t2_srv  (realtimeSinceStartup ms)
 *     [13-20] float64 t2_ptp  (Unix epoch ms, PTP)
 *     [21-28] float64 t0_echo (client t1 echoed)
 *     [29-36] float64 reserved
 */

export class LatencyMeasurer {
  constructor(options = {}) {
    this.targetKey = options.targetKey || 'KeyZ';
    this.sampleWidth = options.sampleWidth || 32;
    this.sampleHeight = options.sampleHeight || 18;
    this.redPixelRatio = options.redPixelRatio || 0.7;
    this.redMin = options.redMin || 180;
    this.maxGreen = options.maxGreen || 80;
    this.maxBlue = options.maxBlue || 80;
    this.minRedDelta = options.minRedDelta || 80;
    this.storageKey = options.storageKey || `latency-history:${window.location.pathname}`;

    // DOM
    this.videoElement = null;
    this.containerElement = null;
    this.panelElement = null;
    this.statusElement = null;
    this.valueElement = null;
    this.sourceElement = null;
    this.segUrllcTxEl = null;
    this.segServerEl = null;
    this.segEmbbTxEl = null;
    this.segClientEl = null;
    this.segNetworkEl = null;
    this.historyElement = null;
    this.summaryElement = null;
    this.downloadElement = null;
    this.clearButtonElement = null;
    this.canvasElement = null;
    this.canvasContext = null;

    // Measurement state
    this.measurementStartTime = null;       // t1 (performance.now)
    this.measurementStartWallClockMs = null; // t1_wall (Date.now, PTP)
    this.measurementActive = false;
    this._seqNo = 0;
    this._urllcChannel = null;
    this._t1PerfSend = null;

    // Pending data – all 3 must arrive before finalizing
    this._pendingAck   = null;  // { seqNo, t2Srv, t2Ptp, t0Echo }
    this._pendingEmbb  = null;  // { seqNo, t3Ptp, t4Perf, t4Wall }
    this._pendingDetection = null; // { timestamp, source }
    this._waitingForCompletion = false;

    this.historyRecords = [];
    this._downloadUrl = null;
    this._loopActive = false;
    this._rafId = null;
    this._boundHandleKeyDown = this._handleKeyDown.bind(this);
    this._boundFrameCallback = this._frameCallback.bind(this);
    this._boundClearHistory = this._clearHistory.bind(this);
    this._finalizeTimeoutId = null;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  attach(videoElement, containerElement) {
    this.detach();

    this.videoElement = videoElement;
    this.containerElement = containerElement;
    this.historyRecords = this._loadHistory();
    this._createPanel();
    this._createSampler();
    this._refreshHistoryUi();

    document.addEventListener('keydown', this._boundHandleKeyDown, false);
    this._loopActive = true;
    this._scheduleNextFrame();
  }

  detach() {
    document.removeEventListener('keydown', this._boundHandleKeyDown, false);
    this._loopActive = false;
    this.measurementActive = false;
    this.measurementStartTime = null;
    this.measurementStartWallClockMs = null;
    this._pendingAck   = null;
    this._pendingEmbb  = null;
    this._pendingDetection = null;
    this._waitingForCompletion = false;
    if (this._finalizeTimeoutId) {
      clearTimeout(this._finalizeTimeoutId);
      this._finalizeTimeoutId = null;
    }

    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    if (this.clearButtonElement) {
      this.clearButtonElement.removeEventListener('click', this._boundClearHistory, false);
    }

    if (this._downloadUrl) {
      URL.revokeObjectURL(this._downloadUrl);
      this._downloadUrl = null;
    }

    if (this.panelElement && this.panelElement.parentNode) {
      this.panelElement.parentNode.removeChild(this.panelElement);
    }

    this.panelElement = null;
    this.statusElement = null;
    this.valueElement = null;
    this.sourceElement = null;
    this.segUrllcTxEl = null;
    this.segServerEl = null;
    this.segEmbbTxEl = null;
    this.segClientEl = null;
    this.segNetworkEl = null;
    this.historyElement = null;
    this.summaryElement = null;
    this.downloadElement = null;
    this.clearButtonElement = null;
    this.canvasElement = null;
    this.canvasContext = null;
    this.videoElement = null;
    this.containerElement = null;
  }

  /**
   * Set the URLLC DataChannel used to send probe packets.
   * Call this after the URLLC DataChannel is open.
   */
  setUrllcChannel(channel) {
    this._urllcChannel = channel;
    console.info('[LatencyMeasurer] URLLC channel set – segment latency ready.');
  }

  /**
   * Called by video-player-dual.js when a server ACK message (0x11) is received.
   * @param {ArrayBuffer|Uint8Array} data
   */
  onServerAck(data) {
    const tAckPerf = performance.now(); // right after ACK received, same timebase as t1PerfSend
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < 29 || bytes[0] !== 0x11) return;

    const view  = new DataView(bytes.buffer, bytes.byteOffset);
    const seqNo = view.getUint32(1, true);
    const t2Srv = view.getFloat64(5, true);
    const t2Ptp = bytes.length >= 37 ? view.getFloat64(13, true) : null;
    const t0Echo = view.getFloat64(21, true);

    // URLLC TX = RTT/2, measured entirely on client (no NTP dependency, no scheduling jitter)
    const urllcRttMs = (this._t1PerfSend != null) ? (tAckPerf - this._t1PerfSend) : null;
    const urllcTxMs  = (urllcRttMs != null) ? urllcRttMs / 2 : null;

    console.info(`[LatencyMeasurer] ACK seqNo=${seqNo} t2_ptp=${t2Ptp?.toFixed(3)} urllcRtt=${urllcRttMs?.toFixed(2)}ms urllcTx=${urllcTxMs?.toFixed(2)}ms`);

    if (!this.measurementActive && !this._waitingForCompletion) {
      console.warn('[LatencyMeasurer] ACK received but no active measurement, ignoring.');
      return;
    }

    this._pendingAck = { seqNo, t2Srv, t2Ptp, t0Echo, urllcTxMs };
    this._tryFinalize();
  }

  /**
   * Called by video-player-dual.js when the eMBB receiver Worker reports a latency stamp.
   * @param {number} seqNo
   * @param {number} t3Ptp  server PTP ms at encode time
   * @param {number} t4Perf client performance.now() at receive time
   * @param {number} t4Wall client Date.now() at receive time
   */
  onEmbbFrameReceived(seqNo, t3Ptp, t4Perf, t4Wall) {
    console.info(`[LatencyMeasurer] eMBB frame seqNo=${seqNo} t3_ptp=${t3Ptp.toFixed(3)} t4_perf=${t4Perf.toFixed(2)}`);

    if (!this.measurementActive && !this._waitingForCompletion) {
      console.warn('[LatencyMeasurer] eMBB stamp received but no active measurement, ignoring.');
      return;
    }

    this._pendingEmbb = { seqNo, t3Ptp, t4Perf, t4Wall };
    this._tryFinalize();
  }

  startMeasurement() {
    this.measurementStartTime = performance.now();
    this.measurementStartWallClockMs = Date.now();
    this.measurementActive = true;
    this._pendingAck  = null;
    this._pendingEmbb = null;
    this._pendingDetection = null;
    this._setPanelState('armed', 'Waiting for ACK + frame stamp + red frame…', 'Measuring...', 'pending');
  }

  // ─── Private: input & frame loop ─────────────────────────────────────────

  _handleKeyDown(event) {
    if (event.code !== this.targetKey || event.repeat) {
      return;
    }

    const t0 = performance.now();
    this._seqNo = (this._seqNo + 1) >>> 0; // wrap at 2^32

    this.measurementStartTime = t0;
    this.measurementStartWallClockMs = Date.now();
    this.measurementActive = true;
    this._pendingAck  = null;
    this._pendingEmbb = null;
    this._pendingDetection = null;
    this._waitingForCompletion = false;

    // Send probe packet if URLLC channel available
    if (this._urllcChannel && this._urllcChannel.readyState === 'open') {
      const probe = this._buildProbePacket(this._seqNo, t0);
      const t1Perf = performance.now(); // right before send, for RTT measurement
      this._t1PerfSend = t1Perf;
      this._urllcChannel.send(probe);
      this._setPanelState('armed', 'Probe sent, waiting ACK + red frame…', 'Measuring...', 'pending');
      console.info(`[LatencyMeasurer] Probe sent seqNo=${this._seqNo}, t0=${t0.toFixed(2)} ms`);
    } else {
      this._t1PerfSend = null;
      // Fallback: no URLLC channel – only E2E will be measured (old behaviour)
      this._setPanelState('armed', 'Waiting for red frame (no URLLC channel)', 'Measuring...', 'pending');
      console.warn('[LatencyMeasurer] URLLC channel not available – segment data will be missing.');
    }
  }

  _frameCallback(now, metadata) {
    this._rafId = null;

    if (!this._loopActive) {
      return;
    }

    if (this.measurementActive && this._sampleFrame()) {
      const detectionInfo = this._getDetectionInfo(now, metadata);
      this.measurementActive = false;
      this._waitingForCompletion = true;
      this._pendingDetection = detectionInfo;
      console.info('[LatencyMeasurer] Red frame detected, waiting for ACK + eMBB stamp...');
      this._tryFinalize();
    }

    this._scheduleNextFrame();
  }

  _getDetectionInfo(now, metadata) {
    if (metadata) {
      if (typeof metadata.expectedDisplayTime === 'number' && Number.isFinite(metadata.expectedDisplayTime)) {
        return { timestamp: metadata.expectedDisplayTime, source: 'expectedDisplayTime' };
      }
      if (typeof metadata.presentationTime === 'number' && Number.isFinite(metadata.presentationTime)) {
        return { timestamp: metadata.presentationTime, source: 'presentationTime' };
      }
    }
    if (typeof now === 'number' && Number.isFinite(now)) {
      return { timestamp: now, source: 'now' };
    }
    return { timestamp: performance.now(), source: 'performance.now()' };
  }

  _scheduleNextFrame() {
    if (!this._loopActive || !this.videoElement) {
      return;
    }
    if (typeof this.videoElement.requestVideoFrameCallback === 'function') {
      this.videoElement.requestVideoFrameCallback(this._boundFrameCallback);
      return;
    }
    this._rafId = requestAnimationFrame(this._boundFrameCallback);
  }

  _sampleFrame() {
    if (!this.videoElement || !this.canvasContext) {
      return false;
    }
    if (this.videoElement.readyState < 2 || !this.videoElement.videoWidth || !this.videoElement.videoHeight) {
      return false;
    }
    this.canvasContext.drawImage(this.videoElement, 0, 0, this.sampleWidth, this.sampleHeight);
    const imageData = this.canvasContext.getImageData(0, 0, this.sampleWidth, this.sampleHeight);
    return this._isRedFrame(imageData.data);
  }

  _isRedFrame(pixelData) {
    let redPixels = 0;
    const totalPixels = pixelData.length / 4;
    for (let index = 0; index < pixelData.length; index += 4) {
      const red   = pixelData[index];
      const green = pixelData[index + 1];
      const blue  = pixelData[index + 2];
      if (red >= this.redMin && green <= this.maxGreen && blue <= this.maxBlue && red - Math.max(green, blue) >= this.minRedDelta) {
        redPixels += 1;
      }
    }
    return redPixels / totalPixels >= this.redPixelRatio;
  }

  _tryFinalize() {
    // Need all 3 pieces: ACK, eMBB frame stamp, red frame detection.
    if (!this._pendingDetection) return; // red frame not yet seen

    // If we have both ACK and eMBB stamp, finalize now.
    if (this._pendingAck && this._pendingEmbb) {
      this._waitingForCompletion = false;
      const det = this._pendingDetection;
      this._pendingDetection = null;
      this._finishMeasurement(det);
      return;
    }

    // Start timeout (500ms) to finalize with whatever we have.
    if (!this._finalizeTimeoutId) {
      this._finalizeTimeoutId = setTimeout(() => {
        this._finalizeTimeoutId = null;
        if (this._pendingDetection) {
          console.warn('[LatencyMeasurer] Timeout waiting for ACK/eMBB stamp, finalizing with partial data.');
          this._waitingForCompletion = false;
          const det = this._pendingDetection;
          this._pendingDetection = null;
          this._finishMeasurement(det);
        }
      }, 500);
    }
  }

  _finishMeasurement(detectionInfo) {
    if (this._finalizeTimeoutId) {
      clearTimeout(this._finalizeTimeoutId);
      this._finalizeTimeoutId = null;
    }

    const t5    = detectionInfo.timestamp;  // red frame display (performance.now timebase)
    const t1    = this.measurementStartTime;
    const t1Wall = this.measurementStartWallClockMs;
    const e2eMs = t5 - t1;

    let urllcTxMs   = null;
    let serverMs    = null;
    let embbTxMs    = null;
    let clientDecMs = null;
    let networkMs   = null;

    if (this._pendingAck && this._pendingEmbb) {
      const { t2Ptp, urllcTxMs: ackUrllcTxMs } = this._pendingAck;
      const { t3Ptp, t4Perf, t4Wall } = this._pendingEmbb;

      urllcTxMs   = ackUrllcTxMs;                                // RTT/2, client-only
      if (t3Ptp && t2Ptp)   serverMs    = t3Ptp  - t2Ptp;       // same server wall clock
      if (t3Ptp && t4Wall)  embbTxMs    = t4Wall - t3Ptp;       // NTP cross-VM
      clientDecMs = t5 - t4Perf;                                 // same client machine

      // Sanity clamp: only discard clearly wrong values (negative = clock error)
      if (urllcTxMs  != null && urllcTxMs  < 0) urllcTxMs  = null;
      if (embbTxMs   != null && embbTxMs   < 0) embbTxMs   = null;
      if (serverMs   != null && serverMs   < 0) serverMs   = null;
      if (clientDecMs != null && clientDecMs < 0) clientDecMs = null;
    } else if (this._pendingAck) {
      urllcTxMs = this._pendingAck.urllcTxMs;
    }

    networkMs = e2eMs - (urllcTxMs ?? 0) - (serverMs ?? 0) - (embbTxMs ?? 0) - (clientDecMs ?? 0);

    const record = this._createHistoryRecord(
      e2eMs, detectionInfo.source, urllcTxMs, serverMs, embbTxMs, clientDecMs, networkMs
    );

    this.measurementActive = false;
    this.measurementStartTime = null;
    this.measurementStartWallClockMs = null;
    this._pendingAck  = null;
    this._pendingEmbb = null;

    this._setPanelState('detected', 'Red frame detected', `${e2eMs.toFixed(2)} ms`, detectionInfo.source);
    this._updateSegmentDisplay(urllcTxMs, serverMs, embbTxMs, clientDecMs, networkMs);
    this._appendHistory(record);

    console.info(`[LatencyMeasurer] E2E=${e2eMs.toFixed(2)}ms urllc=${urllcTxMs?.toFixed(2)}ms server=${serverMs?.toFixed(2)}ms embb=${embbTxMs?.toFixed(2)}ms client=${clientDecMs?.toFixed(2)}ms (${detectionInfo.source})`);
  }

  // ─── Private: probe packet builder ───────────────────────────────────────

  _buildProbePacket(seqNo, t0Ms) {
    // 1 + 4 + 8 = 13 bytes
    const buf = new ArrayBuffer(13);
    const view = new DataView(buf);
    view.setUint8(0, 0x10);
    view.setUint32(1, seqNo, true);
    view.setFloat64(5, t0Ms, true);
    return buf;
  }

  // ─── Private: history ────────────────────────────────────────────────────

  _createHistoryRecord(e2eMs, source, urllcTxMs, serverMs, embbTxMs, clientDecMs, networkMs) {
    const startedAtMs  = this.measurementStartWallClockMs || Date.now();
    const detectedAtMs = startedAtMs + e2eMs;
    const fmt = (v) => v != null ? Number(v.toFixed(2)) : null;
    return {
      id:          startedAtMs,
      startedAt:   new Date(startedAtMs).toISOString(),
      detectedAt:  new Date(detectedAtMs).toISOString(),
      e2eMs:       fmt(e2eMs),
      urllcTxMs:   fmt(urllcTxMs),
      serverMs:    fmt(serverMs),
      embbTxMs:    fmt(embbTxMs),
      clientDecMs: fmt(clientDecMs),
      networkMs:   fmt(networkMs),
      source,
      page:        window.location.pathname,
      key:         this.targetKey,
      latencyMs:   fmt(e2eMs), // backward-compat
    };
  }

  _appendHistory(record) {
    this.historyRecords.push(record);
    this._saveHistory();
    this._refreshHistoryUi();
  }

  _loadHistory() {
    try {
      const rawValue = window.localStorage.getItem(this.storageKey);
      if (!rawValue) return [];
      const parsedValue = JSON.parse(rawValue);
      return Array.isArray(parsedValue) ? parsedValue : [];
    } catch {
      return [];
    }
  }

  _saveHistory() {
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(this.historyRecords));
    } catch {
      // ignore
    }
  }

  _clearHistory() {
    this.historyRecords = [];
    try {
      window.localStorage.removeItem(this.storageKey);
    } catch {
      // ignore
    }
    this._refreshHistoryUi();
  }

  _refreshHistoryUi() {
    if (!this.historyElement || !this.summaryElement || !this.downloadElement || !this.clearButtonElement) {
      return;
    }

    this.historyElement.innerText = `History: ${this.historyRecords.length} record(s)`;
    this.summaryElement.innerText = this._getSummaryText();
    this.clearButtonElement.disabled = this.historyRecords.length === 0;

    if (this._downloadUrl) {
      URL.revokeObjectURL(this._downloadUrl);
      this._downloadUrl = null;
    }

    if (this.historyRecords.length === 0) {
      this.downloadElement.removeAttribute('href');
      this.downloadElement.setAttribute('aria-disabled', 'true');
      return;
    }

    const csvContent = this._toCsv();
    this._downloadUrl = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv;charset=utf-8' }));
    this.downloadElement.href = this._downloadUrl;
    this.downloadElement.download = this._getDownloadFilename();
    this.downloadElement.setAttribute('aria-disabled', 'false');
  }

  _toCsv() {
    const header = ['id', 'startedAt', 'detectedAt', 'e2eMs', 'urllcTxMs', 'serverMs', 'embbTxMs', 'clientDecMs', 'networkMs', 'source', 'page', 'key'];
    const rows = this.historyRecords.map((r) => [
      r.id,
      r.startedAt,
      r.detectedAt,
      r.e2eMs ?? r.latencyMs,
      r.urllcTxMs  ?? '',
      r.serverMs   ?? '',
      r.embbTxMs   ?? '',
      r.clientDecMs ?? '',
      r.networkMs  ?? '',
      r.source,
      r.page,
      r.key,
    ]);
    return [header, ...rows]
      .map((row) => row.map((v) => this._escapeCsvValue(v)).join(','))
      .join('\n');
  }

  _getSummaryText() {
    if (this.historyRecords.length === 0) {
      return 'Avg: --  Min: --  Max: --  P95: --';
    }
    const vals = this.historyRecords
      .map((r) => r.e2eMs ?? r.latencyMs)
      .filter((v) => typeof v === 'number' && Number.isFinite(v));

    if (vals.length === 0) return 'Avg: --  Min: --  Max: --  P95: --';

    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const p95 = this._calculatePercentile(vals, 0.95);
    return `Avg: ${avg.toFixed(2)} ms  Min: ${min.toFixed(2)} ms  Max: ${max.toFixed(2)} ms  P95: ${p95.toFixed(2)} ms`;
  }

  _calculatePercentile(values, percentile) {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil(sorted.length * percentile) - 1);
    return sorted[index];
  }

  _escapeCsvValue(value) {
    const s = String(value ?? '');
    if (!/[",\n]/.test(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
  }

  _getDownloadFilename() {
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    return `latency-history-${date}.csv`;
  }

  // ─── Private: DOM ────────────────────────────────────────────────────────

  _createSampler() {
    this.canvasElement = document.createElement('canvas');
    this.canvasElement.width  = this.sampleWidth;
    this.canvasElement.height = this.sampleHeight;
    this.canvasContext = this.canvasElement.getContext('2d', { willReadFrequently: true });
  }

  _createPanel() {
    if (!this.containerElement) return;

    const panel = document.createElement('div');
    panel.className = 'latency-panel';

    const title = document.createElement('div');
    title.className = 'latency-panel__title';
    title.innerText = 'Latency';
    panel.appendChild(title);

    this.statusElement = document.createElement('div');
    this.statusElement.className = 'latency-panel__status';
    panel.appendChild(this.statusElement);

    this.valueElement = document.createElement('div');
    this.valueElement.className = 'latency-panel__value';
    panel.appendChild(this.valueElement);

    this.sourceElement = document.createElement('div');
    this.sourceElement.className = 'latency-panel__source';
    panel.appendChild(this.sourceElement);

    // ── Segment breakdown table ──
    const segTable = document.createElement('table');
    segTable.className = 'latency-panel__segtable';
    segTable.innerHTML = `
      <tbody>
        <tr><td>📡 URLLC TX</td><td id="_lm_utx">--</td></tr>
        <tr><td>⚙️ Server (render+encode)</td><td id="_lm_srv">--</td></tr>
        <tr><td>📺 eMBB TX</td><td id="_lm_etx">--</td></tr>
        <tr><td>💻 Client decode</td><td id="_lm_cli">--</td></tr>
        <tr><td>🌐 Residual</td><td id="_lm_net">--</td></tr>
      </tbody>`;
    panel.appendChild(segTable);

    this.segUrllcTxEl = segTable.querySelector('#_lm_utx');
    this.segServerEl  = segTable.querySelector('#_lm_srv');
    this.segEmbbTxEl  = segTable.querySelector('#_lm_etx');
    this.segClientEl  = segTable.querySelector('#_lm_cli');
    this.segNetworkEl = segTable.querySelector('#_lm_net');

    this.historyElement = document.createElement('div');
    this.historyElement.className = 'latency-panel__history';
    panel.appendChild(this.historyElement);

    this.summaryElement = document.createElement('div');
    this.summaryElement.className = 'latency-panel__summary';
    panel.appendChild(this.summaryElement);

    const actions = document.createElement('div');
    actions.className = 'latency-panel__actions';

    this.downloadElement = document.createElement('a');
    this.downloadElement.className = 'latency-panel__button';
    this.downloadElement.innerText = 'Download CSV';
    actions.appendChild(this.downloadElement);

    this.clearButtonElement = document.createElement('button');
    this.clearButtonElement.className = 'latency-panel__button';
    this.clearButtonElement.type = 'button';
    this.clearButtonElement.innerText = 'Clear history';
    this.clearButtonElement.addEventListener('click', this._boundClearHistory, false);
    actions.appendChild(this.clearButtonElement);

    panel.appendChild(actions);

    const hint = document.createElement('div');
    hint.className = 'latency-panel__hint';
    hint.innerText = 'Press Z to start';
    panel.appendChild(hint);

    this.containerElement.appendChild(panel);
    this.panelElement = panel;
    this._setPanelState('idle', 'Idle', '--', 'not measured');
  }

  _updateSegmentDisplay(urllcTxMs, serverMs, embbTxMs, clientDecMs, networkMs) {
    const fmt = (v) => v != null ? `${v.toFixed(2)} ms` : '--';
    if (this.segUrllcTxEl) this.segUrllcTxEl.innerText = fmt(urllcTxMs);
    if (this.segServerEl)  this.segServerEl.innerText  = fmt(serverMs);
    if (this.segEmbbTxEl)  this.segEmbbTxEl.innerText  = fmt(embbTxMs);
    if (this.segClientEl)  this.segClientEl.innerText  = fmt(clientDecMs);
    if (this.segNetworkEl) this.segNetworkEl.innerText = fmt(networkMs);
  }

  _setPanelState(state, statusText, valueText, sourceText) {
    if (!this.panelElement || !this.statusElement || !this.valueElement || !this.sourceElement) return;
    this.panelElement.dataset.state = state;
    this.statusElement.innerText    = statusText;
    this.valueElement.innerText     = valueText;
    this.sourceElement.innerText    = `Timing source: ${sourceText}`;
  }
}
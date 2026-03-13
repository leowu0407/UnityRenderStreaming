/**
 * LatencyMeasurer – measures End-to-End latency AND 4 sub-segments for the dual-connection VR streaming system.
 *
 * FLOW (Z key pressed):
 *   1. Record t0 = performance.now()
 *   2. Send binary "probe" packet (0x10) via URLLC DataChannel
 *   3. Server receives probe → records t1 → triggers red flash → waits EndOfFrame → records t2 → sends ACK (0x11)
 *   4. Client receives ACK → records t_ack_recv; stores t1_srv & t2_srv from ACK
 *   5. Per-video-frame canvas sampling detects red frame → t3 = expectedDisplayTime
 *   6. Compute segments:
 *        seg_server  = t2_srv – t1_srv          (server-internal delta, precise)
 *        seg_client  = t3 – t_ack_recv          (client-internal delta, precise)
 *        seg_e2e     = t3 – t0                  (total E2E)
 *        seg_network = seg_e2e – seg_server – seg_client  (URLLC TX + eMBB TX, estimated)
 *
 * PACKET FORMATS:
 *   Probe (Client→Server, 13 bytes):
 *     [0]     uint8   0x10
 *     [1-4]   uint32  seqNo (LE)
 *     [5-12]  float64 t0_ms (LE)
 *
 *   ACK (Server→Client, 29 bytes):
 *     [0]     uint8   0x11
 *     [1-4]   uint32  seqNo (LE)
 *     [5-12]  float64 t1_srv_ms (LE)
 *     [13-20] float64 t2_srv_ms (LE)
 *     [21-28] float64 t0_echo_ms (LE)
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
    this.segServerEl = null;
    this.segClientEl = null;
    this.segNetworkEl = null;
    this.historyElement = null;
    this.summaryElement = null;
    this.downloadElement = null;
    this.clearButtonElement = null;
    this.canvasElement = null;
    this.canvasContext = null;

    // Measurement state
    this.measurementStartTime = null;       // t0 (performance.now)
    this.measurementStartWallClockMs = null;
    this.measurementActive = false;
    this._seqNo = 0;
    this._urllcChannel = null;

    // Set by onServerAck()
    this._pendingAck = null;  // { seqNo, t1Srv, t2Srv, tAckRecv }
    this._pendingDetection = null; // { timestamp, source } stored when red frame seen before ACK
    this._waitingForAck = false;

    this.historyRecords = [];
    this._downloadUrl = null;
    this._loopActive = false;
    this._rafId = null;
    this._boundHandleKeyDown = this._handleKeyDown.bind(this);
    this._boundFrameCallback = this._frameCallback.bind(this);
    this._boundClearHistory = this._clearHistory.bind(this);
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
    this._pendingAck = null;
    this._pendingDetection = null;
    this._waitingForAck = false;

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
    this.segServerEl = null;
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
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < 29 || bytes[0] !== 0x11) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const seqNo  = view.getUint32(1, true);
    const t1Srv  = view.getFloat64(5, true);
    const t2Srv  = view.getFloat64(13, true);
    const t0Echo = view.getFloat64(21, true);

    const tAckRecv = performance.now();

    console.info(`[LatencyMeasurer] ACK received seqNo=${seqNo}, serverDelta=${(t2Srv-t1Srv).toFixed(2)}ms`);

    if (!this.measurementActive && !this._waitingForAck) {
      console.warn('[LatencyMeasurer] ACK received but no active measurement, ignoring.');
      return;
    }

    this._pendingAck = { seqNo, t1Srv, t2Srv, tAckRecv };

    // If red frame was already detected while waiting for ACK, finish now
    if (this._pendingDetection) {
      const det = this._pendingDetection;
      this._pendingDetection = null;
      this._waitingForAck = false;
      this._finishMeasurement(det);
    }
  }

  startMeasurement() {
    this.measurementStartTime = performance.now();
    this.measurementStartWallClockMs = Date.now();
    this.measurementActive = true;
    this._pendingAck = null;
    this._setPanelState('armed', 'Waiting for server ACK & red frame…', 'Measuring...', 'pending');
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
    this._pendingAck = null;

    // Send probe packet if URLLC channel available
    if (this._urllcChannel && this._urllcChannel.readyState === 'open') {
      const probe = this._buildProbePacket(this._seqNo, t0);
      this._urllcChannel.send(probe);
      this._setPanelState('armed', 'Probe sent, waiting ACK + red frame…', 'Measuring...', 'pending');
      console.info(`[LatencyMeasurer] Probe sent seqNo=${this._seqNo}, t0=${t0.toFixed(2)} ms`);
    } else {
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
      this.measurementActive = false; // stop sampling frames

      if (this._pendingAck) {
        // ACK already arrived – finalize immediately
        this._finishMeasurement(detectionInfo);
      } else {
        // ACK not yet arrived – wait up to 300ms
        this._waitingForAck = true;
        this._pendingDetection = detectionInfo;
        console.info('[LatencyMeasurer] Red frame detected, waiting for ACK...');

        const ackWaitStart = performance.now();
        const checkAck = () => {
          if (this._pendingAck) {
            // ACK arrived
            const det = this._pendingDetection;
            this._pendingDetection = null;
            this._waitingForAck = false;
            this._finishMeasurement(det);
          } else if (performance.now() - ackWaitStart > 300) {
            // Timeout – finalize without segments
            console.warn('[LatencyMeasurer] ACK timeout (300ms), finalizing without segment data.');
            const det = this._pendingDetection;
            this._pendingDetection = null;
            this._waitingForAck = false;
            this._finishMeasurement(det);
          } else {
            setTimeout(checkAck, 5);
          }
        };
        setTimeout(checkAck, 5);
      }
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

  _finishMeasurement(detectionInfo) {
    const t3 = detectionInfo.timestamp;   // red frame seen (performance.now() timebase)
    const t0 = this.measurementStartTime;
    const e2eMs = t3 - t0;

    let serverMs  = null;
    let clientMs  = null;
    let networkMs = null;

    if (this._pendingAck) {
      const { t1Srv, t2Srv, tAckRecv } = this._pendingAck;
      serverMs  = t2Srv - t1Srv;          // server-internal delta
      clientMs  = t3 - tAckRecv;          // client-local delta
      networkMs = e2eMs - serverMs - clientMs;
    }

    const record = this._createHistoryRecord(e2eMs, detectionInfo.source, serverMs, clientMs, networkMs);

    this.measurementActive = false;
    this.measurementStartTime = null;
    this.measurementStartWallClockMs = null;
    this._pendingAck = null;

    this._setPanelState('detected', 'Red frame detected', `${e2eMs.toFixed(2)} ms`, detectionInfo.source);
    this._updateSegmentDisplay(serverMs, clientMs, networkMs);
    this._appendHistory(record);

    console.info(`[LatencyMeasurer] E2E: ${e2eMs.toFixed(2)} ms  Server: ${serverMs != null ? serverMs.toFixed(2) : '--'} ms  Client: ${clientMs != null ? clientMs.toFixed(2) : '--'} ms  Network: ${networkMs != null ? networkMs.toFixed(2) : '--'} ms  (source: ${detectionInfo.source})`);
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

  _createHistoryRecord(e2eMs, source, serverMs, clientMs, networkMs) {
    const startedAtMs   = this.measurementStartWallClockMs || Date.now();
    const detectedAtMs  = startedAtMs + e2eMs;

    return {
      id: startedAtMs,
      startedAt:  new Date(startedAtMs).toISOString(),
      detectedAt: new Date(detectedAtMs).toISOString(),
      e2eMs:      Number(e2eMs.toFixed(2)),
      serverMs:   serverMs != null ? Number(serverMs.toFixed(2)) : null,
      clientMs:   clientMs != null ? Number(clientMs.toFixed(2)) : null,
      networkMs:  networkMs != null ? Number(networkMs.toFixed(2)) : null,
      source,
      page:       window.location.pathname,
      key:        this.targetKey,
      // backward-compat alias
      latencyMs:  Number(e2eMs.toFixed(2)),
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
    const header = ['id', 'startedAt', 'detectedAt', 'e2eMs', 'serverMs', 'clientMs', 'networkMs', 'source', 'page', 'key'];
    const rows = this.historyRecords.map((r) => [
      r.id,
      r.startedAt,
      r.detectedAt,
      r.e2eMs ?? r.latencyMs,
      r.serverMs ?? '',
      r.clientMs ?? '',
      r.networkMs ?? '',
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
        <tr><td>🌐 Network (URLLC+eMBB)</td><td id="_lm_net">--</td></tr>
        <tr><td>⚙️ Server (render+encode)</td><td id="_lm_srv">--</td></tr>
        <tr><td>💻 Client (decode+sched)</td><td id="_lm_cli">--</td></tr>
      </tbody>`;
    panel.appendChild(segTable);

    this.segNetworkEl = segTable.querySelector('#_lm_net');
    this.segServerEl  = segTable.querySelector('#_lm_srv');
    this.segClientEl  = segTable.querySelector('#_lm_cli');

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

  _updateSegmentDisplay(serverMs, clientMs, networkMs) {
    if (this.segServerEl)  this.segServerEl.innerText  = serverMs  != null ? `${serverMs.toFixed(2)} ms`  : '--';
    if (this.segClientEl)  this.segClientEl.innerText  = clientMs  != null ? `${clientMs.toFixed(2)} ms`  : '--';
    if (this.segNetworkEl) this.segNetworkEl.innerText = networkMs != null ? `${networkMs.toFixed(2)} ms` : '--';
  }

  _setPanelState(state, statusText, valueText, sourceText) {
    if (!this.panelElement || !this.statusElement || !this.valueElement || !this.sourceElement) return;
    this.panelElement.dataset.state = state;
    this.statusElement.innerText    = statusText;
    this.valueElement.innerText     = valueText;
    this.sourceElement.innerText    = `Timing source: ${sourceText}`;
  }
}
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

    this.videoElement = null;
    this.containerElement = null;
    this.panelElement = null;
    this.statusElement = null;
    this.valueElement = null;
    this.sourceElement = null;
    this.historyElement = null;
    this.summaryElement = null;
    this.downloadElement = null;
    this.clearButtonElement = null;
    this.canvasElement = null;
    this.canvasContext = null;
    this.measurementStartTime = null;
    this.measurementStartWallClockMs = null;
    this.measurementActive = false;
    this.historyRecords = [];
    this._downloadUrl = null;
    this._loopActive = false;
    this._rafId = null;
    this._boundHandleKeyDown = this._handleKeyDown.bind(this);
    this._boundFrameCallback = this._frameCallback.bind(this);
    this._boundClearHistory = this._clearHistory.bind(this);
  }

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
    this.historyElement = null;
    this.summaryElement = null;
    this.downloadElement = null;
    this.clearButtonElement = null;
    this.canvasElement = null;
    this.canvasContext = null;
    this.videoElement = null;
    this.containerElement = null;
  }

  startMeasurement() {
    this.measurementStartTime = performance.now();
    this.measurementStartWallClockMs = Date.now();
    this.measurementActive = true;
    this._setPanelState('armed', 'Waiting for red frame', 'Measuring...', 'pending');
  }

  _handleKeyDown(event) {
    if (event.code !== this.targetKey || event.repeat) {
      return;
    }

    this.startMeasurement();
  }

  _frameCallback(now, metadata) {
    this._rafId = null;

    if (!this._loopActive) {
      return;
    }

    if (this.measurementActive && this._sampleFrame()) {
      this._finishMeasurement(this._getDetectionInfo(now, metadata));
    }

    this._scheduleNextFrame();
  }

  _getDetectionInfo(now, metadata) {
    if (metadata) {
      if (typeof metadata.expectedDisplayTime === 'number' && Number.isFinite(metadata.expectedDisplayTime)) {
        return {
          timestamp: metadata.expectedDisplayTime,
          source: 'expectedDisplayTime'
        };
      }

      if (typeof metadata.presentationTime === 'number' && Number.isFinite(metadata.presentationTime)) {
        return {
          timestamp: metadata.presentationTime,
          source: 'presentationTime'
        };
      }
    }

    if (typeof now === 'number' && Number.isFinite(now)) {
      return {
        timestamp: now,
        source: 'now'
      };
    }

    return {
      timestamp: performance.now(),
      source: 'performance.now()'
    };
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
      const red = pixelData[index];
      const green = pixelData[index + 1];
      const blue = pixelData[index + 2];

      if (
        red >= this.redMin &&
        green <= this.maxGreen &&
        blue <= this.maxBlue &&
        red - Math.max(green, blue) >= this.minRedDelta
      ) {
        redPixels += 1;
      }
    }

    return redPixels / totalPixels >= this.redPixelRatio;
  }

  _finishMeasurement(detectionInfo) {
    const latencyMs = detectionInfo.timestamp - this.measurementStartTime;
    const record = this._createHistoryRecord(latencyMs, detectionInfo.source);

    this.measurementActive = false;
    this.measurementStartTime = null;
    this.measurementStartWallClockMs = null;
    this._setPanelState('detected', 'Red frame detected', `${latencyMs.toFixed(2)} ms`, detectionInfo.source);
    this._appendHistory(record);
    console.info(`[LatencyMeasurer] End-to-end latency: ${latencyMs.toFixed(2)} ms (source: ${detectionInfo.source})`);
  }

  _createHistoryRecord(latencyMs, source) {
    const startedAtMs = this.measurementStartWallClockMs || Date.now();
    const detectedAtMs = startedAtMs + latencyMs;

    return {
      id: startedAtMs,
      startedAt: new Date(startedAtMs).toISOString(),
      detectedAt: new Date(detectedAtMs).toISOString(),
      latencyMs: Number(latencyMs.toFixed(2)),
      source,
      page: window.location.pathname,
      key: this.targetKey
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
      if (!rawValue) {
        return [];
      }

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
      // Ignore storage errors and keep in-memory history available.
    }
  }

  _clearHistory() {
    this.historyRecords = [];

    try {
      window.localStorage.removeItem(this.storageKey);
    } catch {
      // Ignore storage errors.
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
    const header = ['id', 'startedAt', 'detectedAt', 'latencyMs', 'source', 'page', 'key'];
    const rows = this.historyRecords.map((record) => [
      record.id,
      record.startedAt,
      record.detectedAt,
      record.latencyMs,
      record.source,
      record.page,
      record.key
    ]);

    return [header, ...rows]
      .map((row) => row.map((value) => this._escapeCsvValue(value)).join(','))
      .join('\n');
  }

  _getSummaryText() {
    if (this.historyRecords.length === 0) {
      return 'Avg: --  Min: --  Max: --  P95: --';
    }

    const latencyValues = this.historyRecords
      .map((record) => record.latencyMs)
      .filter((value) => typeof value === 'number' && Number.isFinite(value));

    if (latencyValues.length === 0) {
      return 'Avg: --  Min: --  Max: --  P95: --';
    }

    const average = latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length;
    const minimum = Math.min(...latencyValues);
    const maximum = Math.max(...latencyValues);
    const p95 = this._calculatePercentile(latencyValues, 0.95);

    return `Avg: ${average.toFixed(2)} ms  Min: ${minimum.toFixed(2)} ms  Max: ${maximum.toFixed(2)} ms  P95: ${p95.toFixed(2)} ms`;
  }

  _calculatePercentile(values, percentile) {
    if (values.length === 0) {
      return NaN;
    }

    const sortedValues = [...values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(sortedValues.length * percentile) - 1);
    return sortedValues[index];
  }

  _escapeCsvValue(value) {
    const stringValue = String(value ?? '');
    if (!/[",\n]/.test(stringValue)) {
      return stringValue;
    }

    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  _getDownloadFilename() {
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    return `latency-history-${date}.csv`;
  }

  _createSampler() {
    this.canvasElement = document.createElement('canvas');
    this.canvasElement.width = this.sampleWidth;
    this.canvasElement.height = this.sampleHeight;
    this.canvasContext = this.canvasElement.getContext('2d', { willReadFrequently: true });
  }

  _createPanel() {
    if (!this.containerElement) {
      return;
    }

    const panelElement = document.createElement('div');
    panelElement.className = 'latency-panel';

    const titleElement = document.createElement('div');
    titleElement.className = 'latency-panel__title';
    titleElement.innerText = 'Latency';
    panelElement.appendChild(titleElement);

    this.statusElement = document.createElement('div');
    this.statusElement.className = 'latency-panel__status';
    panelElement.appendChild(this.statusElement);

    this.valueElement = document.createElement('div');
    this.valueElement.className = 'latency-panel__value';
    panelElement.appendChild(this.valueElement);

    this.sourceElement = document.createElement('div');
    this.sourceElement.className = 'latency-panel__source';
    panelElement.appendChild(this.sourceElement);

    this.historyElement = document.createElement('div');
    this.historyElement.className = 'latency-panel__history';
    panelElement.appendChild(this.historyElement);

    this.summaryElement = document.createElement('div');
    this.summaryElement.className = 'latency-panel__summary';
    panelElement.appendChild(this.summaryElement);

    const actionsElement = document.createElement('div');
    actionsElement.className = 'latency-panel__actions';

    this.downloadElement = document.createElement('a');
    this.downloadElement.className = 'latency-panel__button';
    this.downloadElement.innerText = 'Download CSV';
    actionsElement.appendChild(this.downloadElement);

    this.clearButtonElement = document.createElement('button');
    this.clearButtonElement.className = 'latency-panel__button';
    this.clearButtonElement.type = 'button';
    this.clearButtonElement.innerText = 'Clear history';
    this.clearButtonElement.addEventListener('click', this._boundClearHistory, false);
    actionsElement.appendChild(this.clearButtonElement);

    panelElement.appendChild(actionsElement);

    const hintElement = document.createElement('div');
    hintElement.className = 'latency-panel__hint';
    hintElement.innerText = 'Press Z to start';
    panelElement.appendChild(hintElement);

    this.containerElement.appendChild(panelElement);
    this.panelElement = panelElement;
    this._setPanelState('idle', 'Idle', '--', 'not measured');
  }

  _setPanelState(state, statusText, valueText, sourceText) {
    if (!this.panelElement || !this.statusElement || !this.valueElement || !this.sourceElement) {
      return;
    }

    this.panelElement.dataset.state = state;
    this.statusElement.innerText = statusText;
    this.valueElement.innerText = valueText;
    this.sourceElement.innerText = `Timing source: ${sourceText}`;
  }
}
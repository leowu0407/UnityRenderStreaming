import { jest } from '@jest/globals';

import { LatencyMeasurer } from '../public/js/latency-measurer.js';

describe('LatencyMeasurer', () => {
  let originalCreateElement;
  let performanceNowSpy;
  let originalRequestAnimationFrame;
  let originalCancelAnimationFrame;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;
  let context;
  let sampledPixels;

  beforeEach(() => {
    window.localStorage.clear();
    sampledPixels = new Uint8ClampedArray(32 * 18 * 4);
    context = {
      drawImage: jest.fn(),
      getImageData: jest.fn(() => ({ data: sampledPixels })),
    };

    originalCreateElement = document.createElement.bind(document);
    document.createElement = jest.fn((tagName) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: jest.fn(() => context),
        };
      }

      return originalCreateElement(tagName);
    });

    performanceNowSpy = jest.spyOn(performance, 'now').mockReturnValue(100);

    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = jest.fn(() => 1);
    window.cancelAnimationFrame = jest.fn(() => {});

    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:test-history');
    URL.revokeObjectURL = jest.fn(() => {});
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
    performanceNowSpy.mockRestore();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  test('starts measuring when Z is pressed', () => {
    const container = document.createElement('div');
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });

    const measurer = new LatencyMeasurer();
    measurer.attach(video, container);

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));

    expect(measurer.measurementActive).toBe(true);
    expect(container.querySelector('.latency-panel__status').innerText).toBe('Waiting for red frame');
    expect(container.querySelector('.latency-panel__source').innerText).toBe('Timing source: pending');
    expect(container.querySelector('.latency-panel__history').innerText).toBe('History: 0 record(s)');
    expect(container.querySelector('.latency-panel__summary').innerText).toBe('Avg: --  Min: --  Max: --  P95: --');
  });

  test('finishes measuring when a red frame is detected', () => {
    const container = document.createElement('div');
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });

    sampledPixels.fill(0);
    for (let index = 0; index < sampledPixels.length; index += 4) {
      sampledPixels[index] = 255;
      sampledPixels[index + 1] = 0;
      sampledPixels[index + 2] = 0;
      sampledPixels[index + 3] = 255;
    }

    const measurer = new LatencyMeasurer();
    measurer.attach(video, container);
    measurer.startMeasurement();
    measurer._frameCallback(140, { expectedDisplayTime: 135 });

    expect(measurer.measurementActive).toBe(false);
    expect(container.querySelector('.latency-panel__status').innerText).toBe('Red frame detected');
    expect(container.querySelector('.latency-panel__value').innerText).toBe('35.00 ms');
    expect(container.querySelector('.latency-panel__source').innerText).toBe('Timing source: expectedDisplayTime');
    expect(container.querySelector('.latency-panel__history').innerText).toBe('History: 1 record(s)');
    expect(container.querySelector('.latency-panel__summary').innerText).toBe('Avg: 35.00 ms  Min: 35.00 ms  Max: 35.00 ms  P95: 35.00 ms');
    expect(window.localStorage.getItem('latency-history:/')).toContain('expectedDisplayTime');
    expect(container.querySelector('.latency-panel__button').getAttribute('href')).toBe('blob:test-history');
  });

  test('falls back to callback time when expected display time is unavailable', () => {
    const container = document.createElement('div');
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });

    sampledPixels.fill(0);
    for (let index = 0; index < sampledPixels.length; index += 4) {
      sampledPixels[index] = 255;
      sampledPixels[index + 1] = 0;
      sampledPixels[index + 2] = 0;
      sampledPixels[index + 3] = 255;
    }

    const measurer = new LatencyMeasurer();
    measurer.attach(video, container);
    measurer.startMeasurement();

    measurer._frameCallback(148, {});

    expect(container.querySelector('.latency-panel__value').innerText).toBe('48.00 ms');
    expect(container.querySelector('.latency-panel__source').innerText).toBe('Timing source: now');
  });

  test('falls back to presentation time when expected display time is unavailable', () => {
    const container = document.createElement('div');
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });

    sampledPixels.fill(0);
    for (let index = 0; index < sampledPixels.length; index += 4) {
      sampledPixels[index] = 255;
      sampledPixels[index + 1] = 0;
      sampledPixels[index + 2] = 0;
      sampledPixels[index + 3] = 255;
    }

    const measurer = new LatencyMeasurer();
    measurer.attach(video, container);
    measurer.startMeasurement();

    measurer._frameCallback(148, { presentationTime: 142 });

    expect(container.querySelector('.latency-panel__value').innerText).toBe('42.00 ms');
    expect(container.querySelector('.latency-panel__source').innerText).toBe('Timing source: presentationTime');
  });

  test('loads existing history and can clear it', () => {
    window.localStorage.setItem('latency-history:/', JSON.stringify([
      {
        id: 1,
        startedAt: '2026-03-11T00:00:00.000Z',
        detectedAt: '2026-03-11T00:00:00.100Z',
        latencyMs: 100,
        source: 'expectedDisplayTime',
        page: '/',
        key: 'KeyZ'
      }
    ]));

    const container = document.createElement('div');
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });

    const measurer = new LatencyMeasurer();
    measurer.attach(video, container);

    expect(container.querySelector('.latency-panel__history').innerText).toBe('History: 1 record(s)');

    container.querySelectorAll('.latency-panel__button')[1].click();

    expect(container.querySelector('.latency-panel__history').innerText).toBe('History: 0 record(s)');
    expect(container.querySelector('.latency-panel__summary').innerText).toBe('Avg: --  Min: --  Max: --  P95: --');
    expect(window.localStorage.getItem('latency-history:/')).toBeNull();
  });

  test('computes summary from history records', () => {
    window.localStorage.setItem('latency-history:/', JSON.stringify([
      { id: 1, startedAt: '2026-03-11T00:00:00.000Z', detectedAt: '2026-03-11T00:00:00.010Z', latencyMs: 10, source: 'expectedDisplayTime', page: '/', key: 'KeyZ' },
      { id: 2, startedAt: '2026-03-11T00:00:01.000Z', detectedAt: '2026-03-11T00:00:01.020Z', latencyMs: 20, source: 'expectedDisplayTime', page: '/', key: 'KeyZ' },
      { id: 3, startedAt: '2026-03-11T00:00:02.000Z', detectedAt: '2026-03-11T00:00:02.030Z', latencyMs: 30, source: 'expectedDisplayTime', page: '/', key: 'KeyZ' },
      { id: 4, startedAt: '2026-03-11T00:00:03.000Z', detectedAt: '2026-03-11T00:00:03.040Z', latencyMs: 40, source: 'expectedDisplayTime', page: '/', key: 'KeyZ' },
      { id: 5, startedAt: '2026-03-11T00:00:04.000Z', detectedAt: '2026-03-11T00:00:04.050Z', latencyMs: 50, source: 'expectedDisplayTime', page: '/', key: 'KeyZ' }
    ]));

    const container = document.createElement('div');
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });

    const measurer = new LatencyMeasurer();
    measurer.attach(video, container);

    expect(container.querySelector('.latency-panel__summary').innerText).toBe('Avg: 30.00 ms  Min: 10.00 ms  Max: 50.00 ms  P95: 50.00 ms');
  });
});
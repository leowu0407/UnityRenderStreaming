/**
 * embb-receiver-worker.js
 *
 * RTCRtpScriptTransform Web Worker for the eMBB video RECEIVER side.
 *
 * For every encoded video frame received from the server:
 *   1. Check if the last 14 bytes contain the latency stamp (magic 0x4C 0x54).
 *   2. If found: extract seqNo + t3_ptp, strip stamp from frame data, record t4.
 *   3. Pass the (clean) frame to the decoder.
 *   4. postMessage the timing data to the main thread.
 *
 * Stamp layout (14 bytes appended by EmbbEncodeTimestamper.cs):
 *   [0-1]  0x4C 0x54  magic 'LT'
 *   [2-5]  uint32 seqNo  (LE)
 *   [6-13] float64 t3_ptp (Unix epoch ms, PTP)
 */

const MAGIC_0 = 0x4C; // 'L'
const MAGIC_1 = 0x54; // 'T'
const STAMP_SIZE = 14;

self.onrtctransform = (event) => {
  const transformer = event.transformer;
  const { readable, writable } = transformer;

  readable.pipeThrough(new TransformStream({
    transform(encodedFrame, controller) {
      const data = new Uint8Array(encodedFrame.data);

      if (data.length >= STAMP_SIZE) {
        const stampStart = data.length - STAMP_SIZE;
        if (data[stampStart] === MAGIC_0 && data[stampStart + 1] === MAGIC_1) {
          const t4Perf = performance.now();
          const t4Wall = Date.now();

          const view  = new DataView(data.buffer, data.byteOffset + stampStart);
          const seqNo = view.getUint32(2, true);
          const t3Ptp = view.getFloat64(6, true);

          encodedFrame.data = data.slice(0, stampStart).buffer;
          self.postMessage({ type: 'latency-stamp', seqNo, t3Ptp, t4Perf, t4Wall });
        }
      }

      controller.enqueue(encodedFrame);
    }
  })).pipeTo(writable);
};

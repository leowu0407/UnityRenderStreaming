/**
 * urllc-probe-worker.js
 *
 * Dedicated Web Worker for URLLC probe/ACK latency measurement.
 * Runs in its own event loop – isolated from main thread UI rendering,
 * DOM events, and requestVideoFrameCallback scheduling.
 *
 * Flow:
 *   main → postMessage({type:'connect', url})  → Worker opens WebSocket
 *   main → postMessage({type:'probe', seqNo, t1Perf})  → Worker sends probe, records tSend
 *   Worker receives ACK → records tRecv → postMessage({type:'ack', seqNo, urllcTxMs, t2})
 *
 * Probe packet (13 bytes):  [0x10][seqNo 4B LE][t1Perf 8B LE]
 * ACK packet   (37 bytes):  [0x11][seqNo 4B][t2Srv 8B][t2 8B][t0Echo 8B][reserved 8B]
 */

let ws = null;
let pendingSend = null; // { seqNo, tSend }

self.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === 'connect') {
    if (ws) { try { ws.close(); } catch {} }
    ws = new WebSocket(msg.url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      self.postMessage({ type: 'connected' });
    };

    ws.onmessage = (e) => {
      // *** Record tRecv HERE – Worker event loop, no main thread UI jitter ***
      const tRecv = performance.now();
      const bytes = new Uint8Array(e.data);
      if (bytes.length < 29 || bytes[0] !== 0x11) return;

      const view   = new DataView(bytes.buffer);
      const seqNo  = view.getUint32(1, true);
      const t2     = view.getFloat64(13, true); // server high-precision ms

      let urllcTxMs = null;
      if (pendingSend && pendingSend.seqNo === seqNo) {
        const rtt = tRecv - pendingSend.tSend;
        urllcTxMs = rtt / 2;
        pendingSend = null;
      }

      self.postMessage({ type: 'ack', seqNo, urllcTxMs, t2 });
    };

    ws.onerror = () => self.postMessage({ type: 'error' });
    ws.onclose = () => self.postMessage({ type: 'closed' });
    return;
  }

  if (msg.type === 'probe') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      self.postMessage({ type: 'error', reason: 'WebSocket not open' });
      return;
    }

    // Build probe packet
    const buf  = new ArrayBuffer(13);
    const view = new DataView(buf);
    view.setUint8(0, 0x10);
    view.setUint32(1, msg.seqNo, true);
    view.setFloat64(5, msg.t1Perf, true);

    // *** Record tSend HERE – right before send(), Worker event loop ***
    const tSend = performance.now();
    pendingSend = { seqNo: msg.seqNo, tSend };
    ws.send(buf);
    return;
  }

  if (msg.type === 'disconnect') {
    try { ws?.close(); } catch {}
    ws = null;
  }
};

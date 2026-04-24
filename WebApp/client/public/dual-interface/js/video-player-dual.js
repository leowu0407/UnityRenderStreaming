import { DualWebSocketSignaling } from "../../module/dual-signaling.js";
import Peer from "../../module/peer.js";
import * as Logger from "../../module/logger.js";
import { LatencyMeasurer } from "../../js/latency-measurer.js";

// enum type of event sending from Unity
var UnityEventType = {
  SWITCH_VIDEO: 0
};

// IP filtering for network slice separation
// Client side: URLLC uses 10.1.128.x (uesimtun1), eMBB uses 10.1.0.x (uesimtun0)
const URLLC_CLIENT_SUBNET = '10.1.128.';
const EMBB_CLIENT_SUBNET = '10.1.0.';

// Server side: URLLC uses 192.168.56.115, eMBB uses 192.168.56.114
const URLLC_SERVER_IP = '192.168.56.115';
const EMBB_SERVER_IP = '192.168.56.114';

/**
 * Filter ICE candidate based on allowed subnet/IP
 * Returns true if candidate should be allowed, false if it should be blocked
 * 
 * @param candidateStr - The ICE candidate string
 * @param allowedPattern - IP or subnet pattern to allow
 * @param blockedPattern - IP or subnet pattern to block
 */
function filterCandidate(candidateStr, allowedPattern, blockedPattern) {
  if (!candidateStr) return true;
  
  // Always allow relay candidates (TURN)
  if (candidateStr.includes('typ relay')) {
    return true;
  }
  
  // Always allow mDNS candidates (*.local)
  if (candidateStr.includes('.local')) {
    return true;
  }
  
  // Block candidates from the wrong subnet/IP
  if (candidateStr.includes(blockedPattern)) {
    Logger.log(`[ICE Filter] Blocking candidate (blocked pattern ${blockedPattern}): ${candidateStr.substring(0, 80)}...`);
    return false;
  }
  
  // Allow candidates from the correct subnet/IP
  if (candidateStr.includes(allowedPattern)) {
    Logger.log(`[ICE Filter] Allowing candidate (allowed pattern ${allowedPattern}): ${candidateStr.substring(0, 80)}...`);
    return true;
  }
  
  // Allow other candidates (e.g., server reflexive from STUN)
  return true;
}

function uuid4() {
  var temp_url = URL.createObjectURL(new Blob());
  var uuid = temp_url.toString();
  URL.revokeObjectURL(temp_url);
  return uuid.split(/[:/]/g).pop().toLowerCase();
}

/**
 * DualVideoPlayer - Video player that uses TWO SEPARATE PeerConnections
 * 
 * Architecture:
 * - pcUrllc: PeerConnection for URLLC channel (DataChannel for input)
 *   - Connects to 192.168.56.115:81
 *   - Client sends input/actions to server
 *   - Uses uesimtun1 (10.60.128.x network)
 * 
 * - pcEmbb: PeerConnection for eMBB channel (Video stream)
 *   - Connects to 192.168.56.114:80
 *   - Client receives video from server
 *   - Uses uesimtun0 (10.60.0.x network)
 */
export class DualVideoPlayer {
  constructor(elements, config) {
    const _this = this;
    this.config = config;
    
    // TWO separate PeerConnections
    this.pcUrllc = null;  // For sending input (DataChannel)
    this.pcEmbb = null;   // For receiving video
    
    this.channelUrllc = null;  // DataChannel on URLLC connection
    
    // Connection IDs - separate for each PeerConnection
    this.connectionIdUrllc = null;
    this.connectionIdEmbb = null;
    
    // Signaling
    this.signaling = null;
    
    // Statistics
    this.inputMessagesSent = 0;
    this.urllcPacketsSent = 0;

    // Main video
    this.localStream = new MediaStream();
    this.video = elements[0];
    this.video.playsInline = true;
    this.video.addEventListener('loadedmetadata', function () {
      _this.video.play();
      _this.resizeVideo();
      _this._updateVideoResolution();
    }, true);

    // Secondary video (thumbnail)
    this.localStream2 = new MediaStream();
    this.videoThumb = elements[1];
    if (this.videoThumb) {
      this.videoThumb.playsInline = true;
      this.videoThumb.addEventListener('loadedmetadata', function () {
        _this.videoThumb.play();
      }, true);
    }

    this.videoTrackList = [];
    this.videoTrackIndex = 0;
    this.maxVideoTrackLength = 2;
    this.latencyMeasurer = new LatencyMeasurer();
    this.latencyMeasurer.attach(this.video, this.video.parentElement);
    this.latencyMeasurer.setStatsProvider(() => this.getStats());
    this.latencyMeasurer.setUrllcCounterProvider(() => this.getUrllcPacketCounters());

    this.ondisconnect = function () { };
    this.onconnected = function () { };
    this.onpaired = function () { };
  }

  _updateVideoResolution() {
    const resolutionEl = document.getElementById('videoResolution');
    if (resolutionEl && this.video) {
      resolutionEl.textContent = `${this.video.videoWidth} x ${this.video.videoHeight}`;
    }
  }

  _updateInputMessageCount() {
    const inputEl = document.getElementById('inputMessagesSent');
    if (inputEl) {
      inputEl.textContent = this.inputMessagesSent.toString();
    }
  }

  async setupConnection() {
    const _this = this;
    
    // Close current connections if exists
    if (this.pcUrllc) {
      Logger.log('Close current URLLC PeerConnection');
      this.pcUrllc.close();
      this.pcUrllc = null;
    }
    if (this.pcEmbb) {
      Logger.log('Close current eMBB PeerConnection');
      this.pcEmbb.close();
      this.pcEmbb = null;
    }

    // Create dual signaling
    this.signaling = new DualWebSocketSignaling(this.config);
    
    // Generate SEPARATE connection IDs for each PeerConnection
    this.connectionIdUrllc = uuid4();
    this.connectionIdEmbb = uuid4();
    
    Logger.log(`[DualVideoPlayer] URLLC Connection ID: ${this.connectionIdUrllc}`);
    Logger.log(`[DualVideoPlayer] eMBB Connection ID: ${this.connectionIdEmbb}`);

    // ==========================================
    // Setup URLLC PeerConnection (for sending input)
    // ==========================================
    this.pcUrllc = new Peer(this.connectionIdUrllc, true);
    
    this.pcUrllc.addEventListener('disconnect', () => {
      Logger.log('[DualVideoPlayer] URLLC PeerConnection disconnected');
    });
    
    this.pcUrllc.addEventListener('sendoffer', (e) => {
      const offer = e.detail;
      Logger.log('[DualVideoPlayer] Sending URLLC offer');
      _this.signaling.sendOfferUrllc(offer.connectionId, offer.sdp);
    });
    
    this.pcUrllc.addEventListener('sendanswer', (e) => {
      const answer = e.detail;
      Logger.log('[DualVideoPlayer] Sending URLLC answer');
      _this.signaling.sendAnswerUrllc(answer.connectionId, answer.sdp);
    });
    
    this.pcUrllc.addEventListener('sendcandidate', (e) => {
      const candidate = e.detail;
      // Log candidate for debugging but let server do the filtering
      // The server has proper IP filtering for URLLC (192.168.56.115)
      Logger.log(`[DualVideoPlayer] URLLC candidate: ${candidate.candidate ? candidate.candidate.substring(0, 80) : 'empty'}`);
      _this.signaling.sendCandidateUrllc(candidate.connectionId, candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex);
    });

    // ==========================================
    // Setup eMBB PeerConnection (for receiving video)
    // ==========================================
    this.pcEmbb = new Peer(this.connectionIdEmbb, true);
    
    this.pcEmbb.addEventListener('disconnect', () => {
      Logger.log('[DualVideoPlayer] eMBB PeerConnection disconnected');
      _this.ondisconnect();
    });
    
    this.pcEmbb.addEventListener('trackevent', (e) => {
      const data = e.detail;
      Logger.log(`[DualVideoPlayer] Received track on eMBB: ${data.track.kind}, readyState: ${data.track.readyState}`);
      
      if (data.track.kind == 'video') {
        // Attach RTCRtpScriptTransform receiver for latency stamping.
        if (data.receiver && typeof RTCRtpScriptTransform !== 'undefined') {
          const worker = new Worker('./js/embb-receiver-worker.js');
          worker.onmessage = (msg) => {
            if (msg.data.type === 'latency-stamp' && _this.latencyMeasurer) {
              // Record t4Perf HERE in main thread – Worker's performance.now() has a
              // different timeOrigin and cannot be compared with t5 (main thread).
              const t4PerfMain = performance.now();
              _this.latencyMeasurer.onEmbbFrameReceived(
                msg.data.seqNo, msg.data.t3, t4PerfMain, msg.data.t4Wall
              );
            }
          };
          data.receiver.transform = new RTCRtpScriptTransform(worker);
          Logger.log('[DualVideoPlayer] eMBB receiver transform installed.');
        }

        _this.videoTrackList.push(data.track);
        
        // Immediately attach the first video track
        if (_this.videoTrackList.length === 1) {
          Logger.log('[DualVideoPlayer] Attaching first video track from eMBB');
          _this.localStream.addTrack(data.track);
          _this.video.srcObject = _this.localStream;
          
          // Force play with error handling
          _this.video.play().then(() => {
            Logger.log('[DualVideoPlayer] Video playback started successfully');
          }).catch(err => {
            Logger.warn(`[DualVideoPlayer] Video play failed: ${err}. User interaction may be needed.`);
          });
        }
      }
      if (data.track.kind == 'audio') {
        _this.localStream.addTrack(data.track);
      }
      if (_this.videoTrackList.length == _this.maxVideoTrackLength) {
        _this.switchVideo(_this.videoTrackIndex);
      }
    });
    
    this.pcEmbb.addEventListener('sendoffer', (e) => {
      const offer = e.detail;
      Logger.log('[DualVideoPlayer] Sending eMBB offer');
      _this.signaling.sendOfferEmbb(offer.connectionId, offer.sdp);
    });
    
    this.pcEmbb.addEventListener('sendanswer', (e) => {
      const answer = e.detail;
      Logger.log('[DualVideoPlayer] Sending eMBB answer');
      _this.signaling.sendAnswerEmbb(answer.connectionId, answer.sdp);
    });
    
    this.pcEmbb.addEventListener('sendcandidate', (e) => {
      const candidate = e.detail;
      // Log candidate for debugging but let server do the filtering
      // The server has proper IP filtering for eMBB (192.168.56.114)
      Logger.log(`[DualVideoPlayer] eMBB candidate: ${candidate.candidate ? candidate.candidate.substring(0, 80) : 'empty'}`);
      _this.signaling.sendCandidateEmbb(candidate.connectionId, candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex);
    });

    // ==========================================
    // Handle signaling events - route to correct PeerConnection
    // ==========================================
    this.signaling.addEventListener('pair-complete', (e) => {
      Logger.log('[DualVideoPlayer] Dual connection paired');
      _this.onpaired();
    });
    
    this.signaling.addEventListener('disconnect', async (e) => {
      const data = e.detail;
      if (_this.pcUrllc != null && _this.pcUrllc.connectionId == data.connectionId) {
        Logger.log('[DualVideoPlayer] URLLC disconnect');
      }
      if (_this.pcEmbb != null && _this.pcEmbb.connectionId == data.connectionId) {
        Logger.log('[DualVideoPlayer] eMBB disconnect');
        _this.ondisconnect();
      }
    });
    
    // Route offers/answers to correct PeerConnection based on channelType
    this.signaling.addEventListener('offer', async (e) => {
      const offer = e.detail;
      Logger.log(`[DualVideoPlayer] Received offer on ${offer.channelType} for connectionId: ${offer.connectionId}`);
      Logger.log(`[DualVideoPlayer] My connectionIdUrllc: ${_this.connectionIdUrllc}, connectionIdEmbb: ${_this.connectionIdEmbb}`);
      const desc = new RTCSessionDescription({ sdp: offer.sdp, type: "offer" });
      
      // Route to correct PeerConnection based on connectionId
      if (offer.connectionId === _this.connectionIdUrllc && _this.pcUrllc != null) {
        Logger.log(`[DualVideoPlayer] Routing offer to pcUrllc (matched connectionId)`);
        await _this.pcUrllc.onGotDescription(offer.connectionId, desc);
      } else if (offer.connectionId === _this.connectionIdEmbb && _this.pcEmbb != null) {
        Logger.log(`[DualVideoPlayer] Routing offer to pcEmbb (matched connectionId)`);
        await _this.pcEmbb.onGotDescription(offer.connectionId, desc);
      } else {
        // Try channelType as fallback
        Logger.log(`[DualVideoPlayer] ConnectionId mismatch, using channelType fallback: ${offer.channelType}`);
        if (offer.channelType === 'urllc' && _this.pcUrllc != null) {
          Logger.log(`[DualVideoPlayer] Routing offer to pcUrllc (channelType fallback)`);
          await _this.pcUrllc.onGotDescription(_this.connectionIdUrllc, desc);
        } else if (offer.channelType === 'embb' && _this.pcEmbb != null) {
          Logger.log(`[DualVideoPlayer] Routing offer to pcEmbb (channelType fallback)`);
          await _this.pcEmbb.onGotDescription(_this.connectionIdEmbb, desc);
        } else {
          Logger.warn(`[DualVideoPlayer] Cannot route offer - no matching PeerConnection. channelType: ${offer.channelType}`);
        }
      }
    });
    
    this.signaling.addEventListener('answer', async (e) => {
      const answer = e.detail;
      Logger.log(`[DualVideoPlayer] Received answer on ${answer.channelType} for connectionId: ${answer.connectionId}`);
      const desc = new RTCSessionDescription({ sdp: answer.sdp, type: "answer" });
      
      // Route to correct PeerConnection based on connectionId
      if (answer.connectionId === _this.connectionIdUrllc && _this.pcUrllc != null) {
        await _this.pcUrllc.onGotDescription(answer.connectionId, desc);
      } else if (answer.connectionId === _this.connectionIdEmbb && _this.pcEmbb != null) {
        await _this.pcEmbb.onGotDescription(answer.connectionId, desc);
      } else {
        // Try channelType as fallback
        if (answer.channelType === 'urllc' && _this.pcUrllc != null) {
          await _this.pcUrllc.onGotDescription(_this.connectionIdUrllc, desc);
        } else if (answer.channelType === 'embb' && _this.pcEmbb != null) {
          await _this.pcEmbb.onGotDescription(_this.connectionIdEmbb, desc);
        }
      }
    });
    
    this.signaling.addEventListener('candidate', async (e) => {
      const candidate = e.detail;
      Logger.log(`[DualVideoPlayer] Received candidate on ${candidate.channelType}: ${candidate.candidate?.substring(0, 60)}...`);
      
      // Server already filters candidates, so we just log and add them
      const iceCandidate = new RTCIceCandidate({ 
        candidate: candidate.candidate, 
        sdpMid: candidate.sdpMid, 
        sdpMLineIndex: candidate.sdpMLineIndex 
      });
      
      // Route to correct PeerConnection based on connectionId
      if (candidate.connectionId === _this.connectionIdUrllc && _this.pcUrllc != null) {
        await _this.pcUrllc.onGotCandidate(candidate.connectionId, iceCandidate);
      } else if (candidate.connectionId === _this.connectionIdEmbb && _this.pcEmbb != null) {
        await _this.pcEmbb.onGotCandidate(candidate.connectionId, iceCandidate);
      } else {
        // Try channelType as fallback
        if (candidate.channelType === 'urllc' && _this.pcUrllc != null) {
          await _this.pcUrllc.onGotCandidate(_this.connectionIdUrllc, iceCandidate);
        } else if (candidate.channelType === 'embb' && _this.pcEmbb != null) {
          await _this.pcEmbb.onGotCandidate(_this.connectionIdEmbb, iceCandidate);
        }
      }
    });

    // Start signaling (establishes both WebSocket connections)
    await this.signaling.start();
    
    // Create SEPARATE connections for each channel
    // URLLC connection - for input DataChannel
    this.signaling.createConnectionUrllc(this.connectionIdUrllc);
    
    // eMBB connection - for video
    this.signaling.createConnectionEmbb(this.connectionIdEmbb);
    
    // Create data channel on URLLC PeerConnection for input
    this.channelUrllc = this.pcUrllc.createDataChannel(this.connectionIdUrllc, 'data', {
      ordered: false,
      maxRetransmits: 0,
    });
    this.channelUrllc.onopen = function () {
      Logger.log('[DualVideoPlayer] URLLC DataChannel connected.');
      _this.onconnected();
      // Give LatencyMeasurer a reference to this channel so it can send probe packets (fallback)
      if (_this.latencyMeasurer) {
        _this.latencyMeasurer.setUrllcChannel(_this.channelUrllc);

        // Connect a dedicated WebSocket for probe/ACK on the URLLC server interface.
        // The server handles this on a background thread (ProbeWebSocketServer.cs),
        // so t2 is recorded without Unity main thread scheduling jitter.
        const probeWsUrl = `ws://${URLLC_SERVER_IP}:9877/probe/`;
        const probeWs = new WebSocket(probeWsUrl);
        probeWs.binaryType = 'arraybuffer';
        probeWs.onopen = () => {
          Logger.log('[DualVideoPlayer] Probe WebSocket connected.');
          _this.latencyMeasurer.setProbeWebSocket(probeWs);
        };
        probeWs.onerror = (e) => Logger.warn('[DualVideoPlayer] Probe WebSocket error, falling back to DataChannel.');
        _this._probeWs = probeWs;
      }
    };
    this.channelUrllc.onerror = function (e) {
      Logger.log("[DualVideoPlayer] URLLC DataChannel error: " + e.error.message);
    };
    this.channelUrllc.onclose = function () {
      Logger.log('[DualVideoPlayer] URLLC DataChannel disconnected.');
    };
    this.channelUrllc.onmessage = async (msg) => {
      let data;
      if (navigator.userAgent.indexOf('Firefox') != -1) {
        data = await msg.data.arrayBuffer();
      } else {
        data = msg.data;
      }
      const bytes = new Uint8Array(data);

      // Route server ACK packets (0x11) to LatencyMeasurer
      if (bytes[0] === 0x11) {
        if (_this.latencyMeasurer) {
          _this.latencyMeasurer.onServerAck(bytes);
        }
        return;
      }

      // Existing message routing
      _this.videoTrackIndex = bytes[1];
      switch (bytes[0]) {
        case UnityEventType.SWITCH_VIDEO:
          _this.switchVideo(_this.videoTrackIndex);
          break;
      }
    };
    
    Logger.log(`[DualVideoPlayer] Dual connection setup complete.`);
    Logger.log(`[DualVideoPlayer] Pair ID: ${this.signaling.getPairId()}`);
    Logger.log(`[DualVideoPlayer] URLLC ID: ${this.connectionIdUrllc}`);
    Logger.log(`[DualVideoPlayer] eMBB ID: ${this.connectionIdEmbb}`);
    
    // Update UI with pair ID
    const pairIdEl = document.getElementById('pairIdDisplay');
    if (pairIdEl) {
      pairIdEl.textContent = this.signaling.getPairId().substring(0, 8) + '...';
    }
  }

  resizeVideo() {
    const clientRect = this.video.getBoundingClientRect();
    const videoRatio = this.videoWidth / this.videoHeight;
    const clientRatio = clientRect.width / clientRect.height;

    this._videoScale = videoRatio > clientRatio ? clientRect.width / this.videoWidth : clientRect.height / this.videoHeight;
    const videoOffsetX = videoRatio > clientRatio ? 0 : (clientRect.width - this.videoWidth * this._videoScale) * 0.5;
    const videoOffsetY = videoRatio > clientRatio ? (clientRect.height - this.videoHeight * this._videoScale) * 0.5 : 0;
    this._videoOriginX = clientRect.left + videoOffsetX;
    this._videoOriginY = clientRect.top + videoOffsetY;
  }

  switchVideo(indexVideoTrack) {
    this.video.srcObject = this.localStream;
    if (this.videoThumb) {
      this.videoThumb.srcObject = this.localStream2;
    }

    if (indexVideoTrack == 0) {
      this.replaceTrack(this.localStream, this.videoTrackList[0]);
      if (this.videoThumb) {
        this.replaceTrack(this.localStream2, this.videoTrackList[1]);
      }
    } else {
      this.replaceTrack(this.localStream, this.videoTrackList[1]);
      if (this.videoThumb) {
        this.replaceTrack(this.localStream2, this.videoTrackList[0]);
      }
    }
  }

  replaceTrack(stream, newTrack) {
    const tracks = stream.getVideoTracks();
    for (const track of tracks) {
      if (track.kind == 'video') {
        stream.removeTrack(track);
      }
    }
    stream.addTrack(newTrack);
  }

  get videoWidth() {
    return this.video.videoWidth;
  }

  get videoHeight() {
    return this.video.videoHeight;
  }

  get videoOriginX() {
    return this._videoOriginX;
  }

  get videoOriginY() {
    return this._videoOriginY;
  }

  get videoScale() {
    return this._videoScale;
  }

  /**
   * Send input message through URLLC DataChannel
   * This goes through uesimtun1 to 192.168.56.115:81
   */
  sendMsg(msg) {
    if (this.channelUrllc == null) {
      return;
    }
    switch (this.channelUrllc.readyState) {
      case 'connecting':
        Logger.log('URLLC DataChannel not ready');
        break;
      case 'open':
        this.channelUrllc.send(msg);
        this.inputMessagesSent++;
        this.urllcPacketsSent++;
        this._updateInputMessageCount();
        break;
      case 'closing':
        Logger.log('Attempt to sendMsg while URLLC closing');
        break;
      case 'closed':
        Logger.log('Attempt to sendMsg while URLLC closed.');
        break;
    }
  }

  async stop() {
    if (this.latencyMeasurer) {
      this.latencyMeasurer.detach();
      this.latencyMeasurer = null;
    }

    if (this._probeWs) {
      this._probeWs.close();
      this._probeWs = null;
    }

    if (this.signaling) {
      await this.signaling.stop();
      this.signaling = null;
    }

    if (this.pcUrllc) {
      this.pcUrllc.close();
      this.pcUrllc = null;
    }
    
    if (this.pcEmbb) {
      this.pcEmbb.close();
      this.pcEmbb = null;
    }
  }

  async getStats() {
    const [embb, urllc] = await Promise.all([
      this.pcEmbb && this.connectionIdEmbb ? this.pcEmbb.getStats(this.connectionIdEmbb) : Promise.resolve(null),
      this.pcUrllc && this.connectionIdUrllc ? this.pcUrllc.getStats(this.connectionIdUrllc) : Promise.resolve(null),
    ]);

    return { embb, urllc };
  }

  getUrllcPacketCounters() {
    return { clientSent: this.urllcPacketsSent >>> 0 };
  }
  
  /**
   * Get the pair ID for this dual connection
   */
  getPairId() {
    return this.signaling ? this.signaling.getPairId() : null;
  }
  
  /**
   * Check if dual connection is ready
   */
  isReady() {
    return this.signaling ? this.signaling.isReady() : false;
  }
}

export default DualVideoPlayer;

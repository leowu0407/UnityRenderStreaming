import { DualWebSocketSignaling } from "../../module/dual-signaling.js";
import Peer from "../../module/peer.js";
import * as Logger from "../../module/logger.js";

// enum type of event sending from Unity
var UnityEventType = {
  SWITCH_VIDEO: 0
};

function uuid4() {
  var temp_url = URL.createObjectURL(new Blob());
  var uuid = temp_url.toString();
  URL.revokeObjectURL(temp_url);
  return uuid.split(/[:/]/g).pop().toLowerCase();
}

/**
 * DualVideoPlayer V2 - Uses TWO separate PeerConnections for true network separation
 * 
 * - pcUrllc: PeerConnection for data channel (input) → via uesimtun1 (URLLC)
 * - pcEmbb: PeerConnection for video stream → via uesimtun0 (eMBB)
 * 
 * This requires the Unity server to also support two separate connections.
 */
export class DualVideoPlayer {
  constructor(elements, config) {
    const _this = this;
    this.config = config;
    
    // TWO separate peer connections
    this.pcUrllc = null;  // For data channel (input) - URLLC
    this.pcEmbb = null;   // For video stream - eMBB
    
    this.channel = null;
    this.connectionIdUrllc = null;
    this.connectionIdEmbb = null;
    
    // Signaling
    this.signaling = null;
    
    // Statistics
    this.inputMessagesSent = 0;
    this.framesReceived = 0;

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
    
    // Close current connections if exist
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
    
    // Generate separate connection IDs for each peer connection
    this.connectionIdUrllc = uuid4();
    this.connectionIdEmbb = uuid4();

    Logger.log(`[DualVideoPlayer] URLLC connection ID: ${this.connectionIdUrllc}`);
    Logger.log(`[DualVideoPlayer] eMBB connection ID: ${this.connectionIdEmbb}`);

    // Create URLLC peer connection (for data channel / input)
    this.pcUrllc = new Peer(this.connectionIdUrllc, true);
    this._setupUrllcPeerEvents();
    
    // Create eMBB peer connection (for video)
    this.pcEmbb = new Peer(this.connectionIdEmbb, true);
    this._setupEmbbPeerEvents();

    // Setup signaling events
    this._setupSignalingEvents();

    // Start signaling (establishes both WebSocket connections)
    await this.signaling.start();
    
    // Create connections on appropriate channels
    // URLLC connection for data channel
    this.signaling.createConnectionUrllc(this.connectionIdUrllc);
    // eMBB connection for video
    this.signaling.createConnectionEmbb(this.connectionIdEmbb);
    
    // Create data channel for input on URLLC peer connection
    this.channel = this.pcUrllc.createDataChannel(this.connectionIdUrllc, 'data');
    this._setupDataChannel();
    
    Logger.log(`[DualVideoPlayer] Dual connection setup complete. Pair ID: ${this.signaling.getPairId()}`);
    
    // Update UI with pair ID
    const pairIdEl = document.getElementById('pairIdDisplay');
    if (pairIdEl) {
      pairIdEl.textContent = this.signaling.getPairId().substring(0, 8) + '...';
    }
  }

  _setupUrllcPeerEvents() {
    const _this = this;
    
    this.pcUrllc.addEventListener('disconnect', () => {
      Logger.log('[DualVideoPlayer] URLLC peer disconnected');
    });
    
    this.pcUrllc.addEventListener('sendoffer', (e) => {
      const offer = e.detail;
      Logger.log('[DualVideoPlayer] Sending offer via URLLC');
      _this.signaling.sendOfferUrllc(offer.connectionId, offer.sdp);
    });
    
    this.pcUrllc.addEventListener('sendanswer', (e) => {
      const answer = e.detail;
      Logger.log('[DualVideoPlayer] Sending answer via URLLC');
      _this.signaling.sendAnswerUrllc(answer.connectionId, answer.sdp);
    });
    
    this.pcUrllc.addEventListener('sendcandidate', (e) => {
      const candidate = e.detail;
      _this.signaling.sendCandidateUrllc(candidate.connectionId, candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex);
    });
  }

  _setupEmbbPeerEvents() {
    const _this = this;
    
    this.pcEmbb.addEventListener('disconnect', () => {
      Logger.log('[DualVideoPlayer] eMBB peer disconnected');
      _this.ondisconnect();
    });
    
    this.pcEmbb.addEventListener('trackevent', (e) => {
      const data = e.detail;
      Logger.log(`[DualVideoPlayer] Received track: ${data.track.kind}`);
      
      if (data.track.kind == 'video') {
        _this.videoTrackList.push(data.track);
        _this.framesReceived++;
        const framesEl = document.getElementById('framesReceived');
        if (framesEl) {
          framesEl.textContent = _this.framesReceived.toString();
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
      Logger.log('[DualVideoPlayer] Sending offer via eMBB');
      _this.signaling.sendOfferEmbb(offer.connectionId, offer.sdp);
    });
    
    this.pcEmbb.addEventListener('sendanswer', (e) => {
      const answer = e.detail;
      Logger.log('[DualVideoPlayer] Sending answer via eMBB');
      _this.signaling.sendAnswerEmbb(answer.connectionId, answer.sdp);
    });
    
    this.pcEmbb.addEventListener('sendcandidate', (e) => {
      const candidate = e.detail;
      _this.signaling.sendCandidateEmbb(candidate.connectionId, candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex);
    });
  }

  _setupSignalingEvents() {
    const _this = this;
    
    this.signaling.addEventListener('pair-complete', (e) => {
      Logger.log('[DualVideoPlayer] Dual connection paired');
      _this.onpaired();
    });
    
    this.signaling.addEventListener('disconnect', async (e) => {
      const data = e.detail;
      if (_this.pcUrllc != null && _this.pcUrllc.connectionId == data.connectionId) {
        Logger.log('[DualVideoPlayer] URLLC connection disconnected');
      }
      if (_this.pcEmbb != null && _this.pcEmbb.connectionId == data.connectionId) {
        Logger.log('[DualVideoPlayer] eMBB connection disconnected');
        _this.ondisconnect();
      }
    });
    
    // Handle offers - route to appropriate peer connection
    this.signaling.addEventListener('offer', async (e) => {
      const offer = e.detail;
      Logger.log(`[DualVideoPlayer] Received offer on ${offer.channelType} for ${offer.connectionId}`);
      const desc = new RTCSessionDescription({ sdp: offer.sdp, type: "offer" });
      
      // Route to appropriate peer connection based on connection ID
      if (offer.connectionId === _this.connectionIdUrllc && _this.pcUrllc != null) {
        await _this.pcUrllc.onGotDescription(offer.connectionId, desc);
      } else if (offer.connectionId === _this.connectionIdEmbb && _this.pcEmbb != null) {
        await _this.pcEmbb.onGotDescription(offer.connectionId, desc);
      } else {
        // Try to match by channel type
        if (offer.channelType === 'urllc' && _this.pcUrllc != null) {
          await _this.pcUrllc.onGotDescription(_this.connectionIdUrllc, desc);
        } else if (offer.channelType === 'embb' && _this.pcEmbb != null) {
          await _this.pcEmbb.onGotDescription(_this.connectionIdEmbb, desc);
        }
      }
    });
    
    // Handle answers - route to appropriate peer connection
    this.signaling.addEventListener('answer', async (e) => {
      const answer = e.detail;
      Logger.log(`[DualVideoPlayer] Received answer on ${answer.channelType} for ${answer.connectionId}`);
      const desc = new RTCSessionDescription({ sdp: answer.sdp, type: "answer" });
      
      if (answer.connectionId === _this.connectionIdUrllc && _this.pcUrllc != null) {
        await _this.pcUrllc.onGotDescription(answer.connectionId, desc);
      } else if (answer.connectionId === _this.connectionIdEmbb && _this.pcEmbb != null) {
        await _this.pcEmbb.onGotDescription(answer.connectionId, desc);
      } else {
        if (answer.channelType === 'urllc' && _this.pcUrllc != null) {
          await _this.pcUrllc.onGotDescription(_this.connectionIdUrllc, desc);
        } else if (answer.channelType === 'embb' && _this.pcEmbb != null) {
          await _this.pcEmbb.onGotDescription(_this.connectionIdEmbb, desc);
        }
      }
    });
    
    // Handle candidates - route to appropriate peer connection
    this.signaling.addEventListener('candidate', async (e) => {
      const candidate = e.detail;
      Logger.log(`[DualVideoPlayer] Received candidate on ${candidate.channelType}`);
      const iceCandidate = new RTCIceCandidate({ 
        candidate: candidate.candidate, 
        sdpMid: candidate.sdpMid, 
        sdpMLineIndex: candidate.sdpMLineIndex 
      });
      
      if (candidate.connectionId === _this.connectionIdUrllc && _this.pcUrllc != null) {
        await _this.pcUrllc.onGotCandidate(candidate.connectionId, iceCandidate);
      } else if (candidate.connectionId === _this.connectionIdEmbb && _this.pcEmbb != null) {
        await _this.pcEmbb.onGotCandidate(candidate.connectionId, iceCandidate);
      } else {
        if (candidate.channelType === 'urllc' && _this.pcUrllc != null) {
          await _this.pcUrllc.onGotCandidate(_this.connectionIdUrllc, iceCandidate);
        } else if (candidate.channelType === 'embb' && _this.pcEmbb != null) {
          await _this.pcEmbb.onGotCandidate(_this.connectionIdEmbb, iceCandidate);
        }
      }
    });
  }

  _setupDataChannel() {
    const _this = this;
    
    this.channel.onopen = function () {
      Logger.log('[DualVideoPlayer] URLLC DataChannel connected.');
      _this.onconnected();
    };
    this.channel.onerror = function (e) {
      Logger.log("[DualVideoPlayer] URLLC DataChannel error: " + e.error.message);
    };
    this.channel.onclose = function () {
      Logger.log('[DualVideoPlayer] URLLC DataChannel disconnected.');
    };
    this.channel.onmessage = async (msg) => {
      let data;
      if (navigator.userAgent.indexOf('Firefox') != -1) {
        data = await msg.data.arrayBuffer();
      } else {
        data = msg.data;
      }
      const bytes = new Uint8Array(data);
      _this.videoTrackIndex = bytes[1];
      switch (bytes[0]) {
        case UnityEventType.SWITCH_VIDEO:
          _this.switchVideo(_this.videoTrackIndex);
          break;
      }
    };
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
      stream.removeTrack(track);
    }
    stream.addTrack(newTrack);
  }

  close() {
    if (this.signaling) {
      this.signaling.stop();
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

  sendMsg(msg) {
    if (this.channel == null) {
      return;
    }
    switch (this.channel.readyState) {
      case 'connecting':
        Logger.log('URLLC connection not ready');
        break;
      case 'open':
        this.channel.send(msg);
        this.inputMessagesSent++;
        this._updateInputMessageCount();
        break;
      case 'closing':
        Logger.log('URLLC connection is closing');
        break;
      case 'closed':
        Logger.log('URLLC connection is closed');
        break;
    }
  }
}

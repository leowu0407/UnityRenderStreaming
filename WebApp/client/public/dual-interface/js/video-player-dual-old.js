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
 * DualVideoPlayer - Video player that uses separate connections for input and video
 * 
 * - URLLC connection: Used to send input/actions from client to server (low latency)
 * - eMBB connection: Used to receive video stream from server (high bandwidth)
 */
export class DualVideoPlayer {
  constructor(elements, config) {
    const _this = this;
    this.config = config;
    
    // Peer connections - we'll use one peer connection that routes through both channels
    this.pc = null;
    this.channel = null;
    this.connectionId = null;
    
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
    
    // Close current connection if exists
    if (this.pc) {
      Logger.log('Close current PeerConnection');
      this.pc.close();
      this.pc = null;
    }

    // Create dual signaling
    this.signaling = new DualWebSocketSignaling(this.config);
    
    // Generate connection ID
    this.connectionId = uuid4();

    // Create peer connection
    this.pc = new Peer(this.connectionId, true);
    
    // Handle peer events
    this.pc.addEventListener('disconnect', () => {
      _this.ondisconnect();
    });
    
    this.pc.addEventListener('trackevent', (e) => {
      const data = e.detail;
      Logger.log(`[DualVideoPlayer] Received track: ${data.track.kind}`);
      
      if (data.track.kind == 'video') {
        _this.videoTrackList.push(data.track);
        _this.framesReceived++;
        const framesEl = document.getElementById('framesReceived');
        if (framesEl) {
          framesEl.textContent = _this.framesReceived.toString();
        }
        
        // Immediately attach the first video track
        if (_this.videoTrackList.length === 1) {
          Logger.log('[DualVideoPlayer] Attaching first video track');
          _this.localStream.addTrack(data.track);
          _this.video.srcObject = _this.localStream;
        }
      }
      if (data.track.kind == 'audio') {
        _this.localStream.addTrack(data.track);
      }
      if (_this.videoTrackList.length == _this.maxVideoTrackLength) {
        _this.switchVideo(_this.videoTrackIndex);
      }
    });
    
    this.pc.addEventListener('sendoffer', (e) => {
      const offer = e.detail;
      // Send offer through URLLC channel
      _this.signaling.sendOffer(offer.connectionId, offer.sdp);
    });
    
    this.pc.addEventListener('sendanswer', (e) => {
      const answer = e.detail;
      _this.signaling.sendAnswer(answer.connectionId, answer.sdp);
    });
    
    this.pc.addEventListener('sendcandidate', (e) => {
      const candidate = e.detail;
      _this.signaling.sendCandidate(candidate.connectionId, candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex);
    });

    // Handle signaling events
    this.signaling.addEventListener('pair-complete', (e) => {
      Logger.log('[DualVideoPlayer] Dual connection paired');
      _this.onpaired();
    });
    
    this.signaling.addEventListener('disconnect', async (e) => {
      const data = e.detail;
      if (_this.pc != null && _this.pc.connectionId == data.connectionId) {
        _this.ondisconnect();
      }
    });
    
    // Offers/Answers should come through eMBB channel
    this.signaling.addEventListener('offer', async (e) => {
      const offer = e.detail;
      Logger.log(`[DualVideoPlayer] Received offer on ${offer.channelType}`);
      const desc = new RTCSessionDescription({ sdp: offer.sdp, type: "offer" });
      if (_this.pc != null) {
        await _this.pc.onGotDescription(offer.connectionId, desc);
      }
    });
    
    this.signaling.addEventListener('answer', async (e) => {
      const answer = e.detail;
      Logger.log(`[DualVideoPlayer] Received answer on ${answer.channelType}`);
      const desc = new RTCSessionDescription({ sdp: answer.sdp, type: "answer" });
      if (_this.pc != null) {
        await _this.pc.onGotDescription(answer.connectionId, desc);
      }
    });
    
    this.signaling.addEventListener('candidate', async (e) => {
      const candidate = e.detail;
      Logger.log(`[DualVideoPlayer] Received candidate on ${candidate.channelType}`);
      const iceCandidate = new RTCIceCandidate({ 
        candidate: candidate.candidate, 
        sdpMid: candidate.sdpMid, 
        sdpMLineIndex: candidate.sdpMLineIndex 
      });
      if (_this.pc != null) {
        await _this.pc.onGotCandidate(candidate.connectionId, iceCandidate);
      }
    });

    // Start signaling (establishes both WebSocket connections)
    await this.signaling.start();
    
    // Create connection on both channels
    this.signaling.createConnection(this.connectionId);
    
    // Create data channel for input
    this.channel = this.pc.createDataChannel(this.connectionId, 'data');
    this.channel.onopen = function () {
      Logger.log('[DualVideoPlayer] DataChannel connected.');
      _this.onconnected();
    };
    this.channel.onerror = function (e) {
      Logger.log("[DualVideoPlayer] DataChannel error: " + e.error.message);
    };
    this.channel.onclose = function () {
      Logger.log('[DualVideoPlayer] DataChannel disconnected.');
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
    
    Logger.log(`[DualVideoPlayer] Connection setup complete. Pair ID: ${this.signaling.getPairId()}`);
    
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
   * Send input message through data channel
   * This goes through the URLLC path
   */
  sendMsg(msg) {
    if (this.channel == null) {
      return;
    }
    switch (this.channel.readyState) {
      case 'connecting':
        Logger.log('Connection not ready');
        break;
      case 'open':
        this.channel.send(msg);
        this.inputMessagesSent++;
        this._updateInputMessageCount();
        break;
      case 'closing':
        Logger.log('Attempt to sendMsg while closing');
        break;
      case 'closed':
        Logger.log('Attempt to sendMsg while connection closed.');
        break;
    }
  }

  async stop() {
    if (this.signaling) {
      await this.signaling.stop();
      this.signaling = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
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

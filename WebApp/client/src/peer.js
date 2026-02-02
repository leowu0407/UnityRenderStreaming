import * as Logger from "./logger.js";

export default class Peer extends EventTarget {
  constructor(connectionId, polite, config, resendIntervalMsec = 5000) {
    super();
    const _this = this;
    this.connectionId = connectionId;
    this.polite = polite;
    this.config = config;
    this.pc = new RTCPeerConnection(this.config);
    this.makingOffer = false;
    this.waitingAnswer = false;
    this.ignoreOffer = false;
    this.srdAnswerPending = false;
    this.log = str => void Logger.log(`[${_this.polite ? 'POLITE' : 'IMPOLITE'}] ${str}`);
    this.warn = str => void Logger.warn(`[${_this.polite ? 'POLITE' : 'IMPOLITE'}] ${str}`);
    this.assert_equals = window.assert_equals ? window.assert_equals : (a, b, msg) => { if (a === b) { return; } throw new Error(`${msg} expected ${b} but got ${a}`); };
    this.interval = resendIntervalMsec;
    this.sleep = msec => new Promise(resolve => setTimeout(resolve, msec));

    this.pc.ontrack = e => {
      _this.log(`ontrack:${e}`);
      _this.dispatchEvent(new CustomEvent('trackevent', { detail: e }));
    };
    this.pc.ondatachannel = e => {
      _this.log(`ondatachannel:${e}`);
      _this.dispatchEvent(new CustomEvent('adddatachannel', { detail: e }));
    };
    this.pc.onicecandidate = ({ candidate }) => {
      _this.log(`send candidate:${candidate}`);
      if (candidate == null) {
        return;
      }
      _this.dispatchEvent(new CustomEvent('sendcandidate', { detail: { connectionId: _this.connectionId, candidate: candidate.candidate, sdpMLineIndex: candidate.sdpMLineIndex, sdpMid: candidate.sdpMid } }));
    };

    this.pc.onnegotiationneeded = this._onNegotiation.bind(this);

    this.pc.onsignalingstatechange = () => {
      _this.log(`signalingState changed:${_this.pc.signalingState}`);
    };

    this.pc.oniceconnectionstatechange = () => {
      _this.log(`iceConnectionState changed:${_this.pc.iceConnectionState}`);
      if (_this.pc.iceConnectionState === 'disconnected') {
        this.dispatchEvent(new Event('disconnect'));
      }
    };

    this.pc.onicegatheringstatechange = () => {
      _this.log(`iceGatheringState changed:${_this.pc.iceGatheringState}'`);
    };

    this.loopResendOffer();
  }

  async _onNegotiation() {
    try {
      this.log(`SLD due to negotiationneeded`);
      this.assert_equals(this.pc.signalingState, 'stable', 'negotiationneeded always fires in stable state');
      this.assert_equals(this.makingOffer, false, 'negotiationneeded not already in progress');
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      this.assert_equals(this.pc.signalingState, 'have-local-offer', 'negotiationneeded not racing with onmessage');
      this.assert_equals(this.pc.localDescription.type, 'offer', 'negotiationneeded SLD worked');
      this.waitingAnswer = true;
      this.dispatchEvent(new CustomEvent('sendoffer', { detail: { connectionId: this.connectionId, sdp: this.pc.localDescription.sdp } }));
    } catch (e) {
      this.log(e);
    } finally {
      this.makingOffer = false;
    }
  }

  async loopResendOffer() {
    while (this.connectionId) {
      if (this.pc && this.waitingAnswer) {
        this.dispatchEvent(new CustomEvent('sendoffer', { detail: { connectionId: this.connectionId, sdp: this.pc.localDescription.sdp } }));
      }
      await this.sleep(this.interval);
    }
  }

  close() {
    this.connectionId = null;
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  getTransceivers(connectionId) {
    if (this.connectionId != connectionId) {
      return null;
    }

    return this.pc.getTransceivers();
  }

  addTrack(connectionId, track) {
    if (this.connectionId != connectionId) {
      return null;
    }

    return this.pc.addTrack(track);
  }

  addTransceiver(connectionId, trackOrKind, init) {
    if (this.connectionId != connectionId) {
      return null;
    }

    return this.pc.addTransceiver(trackOrKind, init);
  }

  createDataChannel(connectionId, label) {
    if (this.connectionId != connectionId) {
      return null;
    }

    return this.pc.createDataChannel(label);
  }

  async getStats(connectionId) {
    if (this.connectionId != connectionId) {
      return null;
    }

    return await this.pc.getStats();
  }

  async onGotDescription(connectionId, description) {
    if (this.connectionId != connectionId) {
      return;
    }

    const _this = this;
    const isStable =
      this.pc.signalingState == 'stable' ||
      (this.pc.signalingState == 'have-local-offer' && this.srdAnswerPending);
    this.ignoreOffer =
      description.type == 'offer' && !this.polite && (this.makingOffer || !isStable);

    if (this.ignoreOffer) {
      _this.log(`glare - ignoring offer`);
      return;
    }

    this.waitingAnswer = false;
    this.srdAnswerPending = description.type == 'answer';
    
    // Check if we're trying to set an answer when already stable
    if (description.type == 'answer' && this.pc.signalingState == 'stable') {
      _this.log(`Ignoring answer - already in stable state`);
      return;
    }
    
    // Check if we're trying to set an offer while in have-local-offer state (collision)
    if (description.type == 'offer' && this.pc.signalingState == 'have-local-offer') {
      if (!this.polite) {
        _this.log(`Ignoring offer - we're impolite and already have local offer`);
        return;
      }
      // We're polite, so rollback our offer
      _this.log(`Rolling back local offer to accept remote offer`);
      await this.pc.setLocalDescription({ type: 'rollback' });
    }
    
    _this.log(`SRD(${description.type}) - current state: ${this.pc.signalingState}`);
    
    try {
      await this.pc.setRemoteDescription(description);
    } catch (err) {
      _this.log(`Error setting remote description: ${err.message}`);
      return;
    }
    
    this.srdAnswerPending = false;

    if (description.type == 'offer') {
      _this.dispatchEvent(new CustomEvent('ongotoffer', { detail: { connectionId: _this.connectionId } }));

      if (this.pc.signalingState !== 'have-remote-offer') {
        _this.log(`Unexpected state after setting remote offer: ${this.pc.signalingState}`);
        return;
      }
      
      _this.log('SLD to get back to stable');
      await this.pc.setLocalDescription();
      
      if (this.pc.signalingState !== 'stable') {
        _this.log(`Warning: Expected stable after SLD but got ${this.pc.signalingState}`);
      }
      
      _this.dispatchEvent(new CustomEvent('sendanswer', { detail: { connectionId: _this.connectionId, sdp: _this.pc.localDescription.sdp } }));

    } else {
      _this.dispatchEvent(new CustomEvent('ongotanswer', { detail: { connectionId: _this.connectionId } }));
      this.pc.dispatchEvent(new Event('negotiated'));
    }
  }

  async onGotCandidate(connectionId, candidate) {
    if (this.connectionId != connectionId) {
      return;
    }

    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      if (this.pc && !this.ignoreOffer)
        this.warn(`${this.pc} this candidate can't accept current signaling state ${this.pc.signalingState}.`);
    }
  }
}

import * as Logger from "./logger.js";

/**
 * DualWebSocketSignaling - Manages two separate WebSocket connections for dual-interface networking
 * 
 * Architecture:
 * - URLLC Connection (uesimtun1, 10.60.128.x): Client sends input/actions to server
 * - eMBB Connection (uesimtun0, 10.60.0.x): Server sends video/stream to client
 * 
 * Both connections share a common pairId to allow the server to route messages correctly.
 */
export class DualWebSocketSignaling extends EventTarget {

  constructor(config, interval = 1000) {
    super();
    this.config = {
      urllcHost: config.urllcHost || '192.168.56.115',
      embbHost: config.embbHost || '192.168.56.114',
      urllcPort: config.urllcPort || 81,  // URLLC uses port 81
      embbPort: config.embbPort || 80,    // eMBB uses port 80
      secure: config.secure || false,
    };
    
    this.interval = interval;
    this.sleep = msec => new Promise(resolve => setTimeout(resolve, msec));
    
    this.pairId = this._generatePairId();
    
    this.wsUrllc = null;
    this.wsEmbb = null;
    
    this.isUrllcOpen = false;
    this.isEmbbOpen = false;
    
    this.connectionId = null;
  }

  _generatePairId() {
    const temp_url = URL.createObjectURL(new Blob());
    const uuid = temp_url.toString();
    URL.revokeObjectURL(temp_url);
    return uuid.split(/[:/]/g).pop().toLowerCase();
  }

  async start() {
    const protocol = this.config.secure ? 'wss://' : 'ws://';
    
    // Create eMBB WebSocket (for receiving video)
    const embbUrl = `${protocol}${this.config.embbHost}:${this.config.embbPort}`;
    Logger.log(`[DualSignaling] Connecting eMBB to ${embbUrl}`);
    this.wsEmbb = new WebSocket(embbUrl);
    
    this.wsEmbb.onopen = () => {
      this.isEmbbOpen = true;
      Logger.log('[DualSignaling] eMBB connection opened');
      this._registerConnection(this.wsEmbb, 'embb');
    };
    
    this.wsEmbb.onclose = () => {
      this.isEmbbOpen = false;
      Logger.log('[DualSignaling] eMBB connection closed');
    };
    
    this.wsEmbb.onerror = (error) => {
      Logger.warn(`[DualSignaling] eMBB WebSocket error: ${error}`);
    };
    
    this.wsEmbb.onmessage = (event) => {
      this._handleMessage(event, 'embb');
    };
    
    // Create URLLC WebSocket (for sending input)
    const urllcUrl = `${protocol}${this.config.urllcHost}:${this.config.urllcPort}`;
    Logger.log(`[DualSignaling] Connecting URLLC to ${urllcUrl}`);
    this.wsUrllc = new WebSocket(urllcUrl);
    
    this.wsUrllc.onopen = () => {
      this.isUrllcOpen = true;
      Logger.log('[DualSignaling] URLLC connection opened');
      this._registerConnection(this.wsUrllc, 'urllc');
    };
    
    this.wsUrllc.onclose = () => {
      this.isUrllcOpen = false;
      Logger.log('[DualSignaling] URLLC connection closed');
    };
    
    this.wsUrllc.onerror = (error) => {
      Logger.warn(`[DualSignaling] URLLC WebSocket error: ${error}`);
    };
    
    this.wsUrllc.onmessage = (event) => {
      this._handleMessage(event, 'urllc');
    };
    
    // Wait for both connections to be ready
    while (!this.isUrllcOpen || !this.isEmbbOpen) {
      await this.sleep(100);
    }
    
    Logger.log('[DualSignaling] Both connections established');
  }

  _registerConnection(ws, channelType) {
    const registerMsg = JSON.stringify({
      type: 'register-dual',
      pairId: this.pairId,
      channelType: channelType
    });
    ws.send(registerMsg);
    Logger.log(`[DualSignaling] Registered ${channelType} channel with pairId: ${this.pairId}`);
  }

  _handleMessage(event, wsChannelType) {
    const msg = JSON.parse(event.data);
    if (!msg) {
      return;
    }

    // Use channelType from message if available, otherwise use WebSocket channel type
    const channelType = msg.channelType || wsChannelType;
    
    Logger.log(`[DualSignaling] ${wsChannelType} received (channelType=${channelType}):`, msg.type);

    switch (msg.type) {
      case 'register-dual-ack':
        Logger.log(`[DualSignaling] ${channelType} registration acknowledged`);
        break;
      case 'pair-complete':
        Logger.log(`[DualSignaling] Dual connection pairing complete`);
        this.dispatchEvent(new CustomEvent('pair-complete', { detail: { pairId: this.pairId } }));
        break;
      case 'connect':
        this.dispatchEvent(new CustomEvent('connect', { detail: msg }));
        break;
      case 'disconnect':
        this.dispatchEvent(new CustomEvent('disconnect', { detail: msg }));
        break;
      case 'offer':
        Logger.log(`[DualSignaling] Dispatching offer with channelType=${channelType}`);
        this.dispatchEvent(new CustomEvent('offer', { 
          detail: { 
            connectionId: msg.from, 
            sdp: msg.data.sdp, 
            polite: msg.data.polite,
            channelType: channelType 
          } 
        }));
        break;
      case 'answer':
        Logger.log(`[DualSignaling] Dispatching answer with channelType=${channelType}`);
        this.dispatchEvent(new CustomEvent('answer', { 
          detail: { 
            connectionId: msg.from, 
            sdp: msg.data.sdp,
            channelType: channelType 
          } 
        }));
        break;
      case 'candidate':
        this.dispatchEvent(new CustomEvent('candidate', { 
          detail: { 
            connectionId: msg.from, 
            candidate: msg.data.candidate, 
            sdpMLineIndex: msg.data.sdpMLineIndex, 
            sdpMid: msg.data.sdpMid,
            channelType: channelType 
          } 
        }));
        break;
      case 'error':
        Logger.warn(`[DualSignaling] Error: ${msg.message}`);
        this.dispatchEvent(new CustomEvent('error', { detail: msg }));
        break;
      default:
        break;
    }
  }

  async stop() {
    if (this.wsUrllc) {
      this.wsUrllc.close();
    }
    if (this.wsEmbb) {
      this.wsEmbb.close();
    }
    
    while (this.isUrllcOpen || this.isEmbbOpen) {
      await this.sleep(100);
    }
  }

  createConnection(connectionId) {
    this.connectionId = connectionId;
    
    const urllcMsg = JSON.stringify({ 
      type: 'connect', 
      connectionId: connectionId,
      pairId: this.pairId,
      channelType: 'urllc'
    });
    Logger.log(`[DualSignaling] Creating URLLC connection: ${urllcMsg}`);
    this.wsUrllc.send(urllcMsg);
    
    const embbMsg = JSON.stringify({ 
      type: 'connect', 
      connectionId: connectionId,
      pairId: this.pairId,
      channelType: 'embb'
    });
    Logger.log(`[DualSignaling] Creating eMBB connection: ${embbMsg}`);
    this.wsEmbb.send(embbMsg);
  }

  deleteConnection(connectionId) {
    const msg = JSON.stringify({ 
      type: 'disconnect', 
      connectionId: connectionId,
      pairId: this.pairId 
    });
    
    if (this.isUrllcOpen) {
      this.wsUrllc.send(msg);
    }
    if (this.isEmbbOpen) {
      this.wsEmbb.send(msg);
    }
  }

  sendOffer(connectionId, sdp) {
    const data = { sdp: sdp, connectionId: connectionId };
    const msg = JSON.stringify({ 
      type: 'offer', 
      from: connectionId, 
      data: data,
      pairId: this.pairId,
      channelType: 'urllc'
    });
    Logger.log(`[DualSignaling] Sending offer via URLLC`);
    this.wsUrllc.send(msg);
  }

  sendAnswer(connectionId, sdp) {
    const data = { sdp: sdp, connectionId: connectionId };
    const msg = JSON.stringify({ 
      type: 'answer', 
      from: connectionId, 
      data: data,
      pairId: this.pairId,
      channelType: 'urllc'
    });
    Logger.log(`[DualSignaling] Sending answer via URLLC`);
    this.wsUrllc.send(msg);
  }

  sendCandidate(connectionId, candidate, sdpMLineIndex, sdpMid) {
    const data = {
      candidate: candidate,
      sdpMLineIndex: sdpMLineIndex,
      sdpMid: sdpMid,
      connectionId: connectionId
    };
    const msg = JSON.stringify({ 
      type: 'candidate', 
      from: connectionId, 
      data: data,
      pairId: this.pairId,
      channelType: 'urllc'
    });
    Logger.log(`[DualSignaling] Sending candidate via URLLC`);
    this.wsUrllc.send(msg);
  }

  getPairId() {
    return this.pairId;
  }

  isReady() {
    return this.isUrllcOpen && this.isEmbbOpen;
  }

  // Channel-specific methods
  createConnectionUrllc(connectionId) {
    const msg = JSON.stringify({ 
      type: 'connect', 
      connectionId: connectionId,
      pairId: this.pairId,
      channelType: 'urllc'
    });
    Logger.log(`[DualSignaling] Creating URLLC-only connection: ${connectionId}`);
    this.wsUrllc.send(msg);
  }

  createConnectionEmbb(connectionId) {
    const msg = JSON.stringify({ 
      type: 'connect', 
      connectionId: connectionId,
      pairId: this.pairId,
      channelType: 'embb'
    });
    Logger.log(`[DualSignaling] Creating eMBB-only connection: ${connectionId}`);
    this.wsEmbb.send(msg);
  }

  sendOfferUrllc(connectionId, sdp) {
    const data = { sdp: sdp, connectionId: connectionId };
    const msg = JSON.stringify({ 
      type: 'offer', 
      from: connectionId, 
      data: data,
      pairId: this.pairId,
      channelType: 'urllc'
    });
    Logger.log(`[DualSignaling] Sending URLLC offer`);
    this.wsUrllc.send(msg);
  }

  sendOfferEmbb(connectionId, sdp) {
    const data = { sdp: sdp, connectionId: connectionId };
    const msg = JSON.stringify({ 
      type: 'offer', 
      from: connectionId, 
      data: data,
      pairId: this.pairId,
      channelType: 'embb'
    });
    Logger.log(`[DualSignaling] Sending eMBB offer`);
    this.wsEmbb.send(msg);
  }

  sendAnswerUrllc(connectionId, sdp) {
    const data = { sdp: sdp, connectionId: connectionId };
    const msg = JSON.stringify({ 
      type: 'answer', 
      from: connectionId, 
      data: data,
      pairId: this.pairId,
      channelType: 'urllc'
    });
    Logger.log(`[DualSignaling] Sending URLLC answer`);
    this.wsUrllc.send(msg);
  }

  sendAnswerEmbb(connectionId, sdp) {
    const data = { sdp: sdp, connectionId: connectionId };
    const msg = JSON.stringify({ 
      type: 'answer', 
      from: connectionId, 
      data: data,
      pairId: this.pairId,
      channelType: 'embb'
    });
    Logger.log(`[DualSignaling] Sending eMBB answer`);
    this.wsEmbb.send(msg);
  }

  sendCandidateUrllc(connectionId, candidate, sdpMLineIndex, sdpMid) {
    const data = {
      candidate: candidate,
      sdpMLineIndex: sdpMLineIndex,
      sdpMid: sdpMid,
      connectionId: connectionId
    };
    const msg = JSON.stringify({ 
      type: 'candidate', 
      from: connectionId, 
      data: data,
      pairId: this.pairId,
      channelType: 'urllc'
    });
    this.wsUrllc.send(msg);
  }

  sendCandidateEmbb(connectionId, candidate, sdpMLineIndex, sdpMid) {
    const data = {
      candidate: candidate,
      sdpMLineIndex: sdpMLineIndex,
      sdpMid: sdpMid,
      connectionId: connectionId
    };
    const msg = JSON.stringify({ 
      type: 'candidate', 
      from: connectionId, 
      data: data,
      pairId: this.pairId,
      channelType: 'embb'
    });
    this.wsEmbb.send(msg);
  }
}

export default DualWebSocketSignaling;

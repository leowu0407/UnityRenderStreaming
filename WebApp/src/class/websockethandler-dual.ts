import Offer from './offer';
import Answer from './answer';
import Candidate from './candidate';

let isPrivate: boolean;

// IP filtering configuration for dual-connection architecture
// eMBB (video) uses 192.168.56.114, URLLC (input) uses 192.168.56.115
const EMBB_IP = '192.168.56.114';
const URLLC_IP = '192.168.56.115';

/**
 * Filter ICE candidate string to only allow the specified IP
 * Returns null if the candidate should be dropped
 */
function filterCandidateByIP(candidateStr: string, allowedIP: string): boolean {
  if (!candidateStr) return false;
  
  // Check if the candidate contains the allowed IP
  // ICE candidate format: "candidate:... <priority> <ip> <port> ..."
  if (candidateStr.includes(allowedIP)) {
    return true;
  }
  
  // Allow mDNS candidates (*.local) and relay candidates
  if (candidateStr.includes('.local') || candidateStr.includes('typ relay')) {
    return true;
  }
  
  // Block candidates with other IPs (192.168.56.x that don't match)
  if (candidateStr.includes('192.168.56.') || candidateStr.includes('10.0.2.')) {
    return false;
  }
  
  // Allow other candidates (like STUN server reflexive)
  return true;
}

/**
 * Rewrite candidate in SDP to only include allowed IPs
 */
function filterSdpCandidates(sdp: string, allowedIP: string): string {
  if (!sdp) return sdp;
  
  const lines = sdp.split('\r\n');
  const filteredLines = lines.filter(line => {
    if (line.startsWith('a=candidate:')) {
      // Check if this candidate line contains the allowed IP
      if (line.includes(allowedIP)) {
        return true;
      }
      // Allow mDNS and relay candidates
      if (line.includes('.local') || line.includes('typ relay')) {
        return true;
      }
      // Block candidates with other local IPs
      if (line.includes('192.168.56.') || line.includes('10.0.2.')) {
        console.log(`[DualHandler] Filtering out SDP candidate: ${line.substring(0, 80)}...`);
        return false;
      }
      return true;
    }
    return true;
  });
  
  return filteredLines.join('\r\n');
}

// [{sessionId:[connectionId,...]}]
const clients: Map<WebSocket, Set<string>> = new Map<WebSocket, Set<string>>();

// [{connectionId:[sessionId1, sessionId2]}]
const connectionPair: Map<string, [WebSocket, WebSocket]> = new Map<string, [WebSocket, WebSocket]>();

// Track which server (port) each WebSocket belongs to
// 'embb' = port 80, 'urllc' = port 81
const wsServerType: Map<WebSocket, 'embb' | 'urllc'> = new Map<WebSocket, 'embb' | 'urllc'>();

// Dual connection support:
// Maps pairId to the two WebSocket connections (urllc and embb)
interface DualPair {
  urllc: WebSocket | null;
  embb: WebSocket | null;
  connectionIdUrllc: string | null;  // Client's URLLC connection ID
  connectionIdEmbb: string | null;   // Client's eMBB connection ID
  unityWsEmbb: WebSocket | null;     // Unity eMBB server WebSocket
  unityWsUrllc: WebSocket | null;    // Unity URLLC server WebSocket
  // Track Unity's connectionId for video (may differ from client's)
  unityVideoConnectionId: string | null;
}
const dualPairs: Map<string, DualPair> = new Map<string, DualPair>();

// Maps WebSocket to its dual pair info
interface DualConnectionInfo {
  pairId: string;
  channelType: 'urllc' | 'embb';
}
const wsDualInfo: Map<WebSocket, DualConnectionInfo> = new Map<WebSocket, DualConnectionInfo>();

// Maps connectionId to pairId for routing
const connectionToPair: Map<string, string> = new Map<string, string>();

// Maps connectionId to channel type (to track video connection IDs from Unity)
const connectionToChannel: Map<string, 'urllc' | 'embb'> = new Map<string, 'urllc' | 'embb'>();

function getOrCreateConnectionIds(session: WebSocket): Set<string> {
  let connectionIds = null;
  if (!clients.has(session)) {
    connectionIds = new Set<string>();
    clients.set(session, connectionIds);
  }
  connectionIds = clients.get(session);
  return connectionIds;
}

function reset(mode: string): void {
  isPrivate = mode == "private";
}

function add(ws: WebSocket, serverType: 'embb' | 'urllc' = 'embb'): void {
  clients.set(ws, new Set<string>());
  wsServerType.set(ws, serverType);
  console.log(`[DualHandler] WebSocket added to ${serverType} server`);
}

function remove(ws: WebSocket): void {
  const connectionIds = clients.get(ws);
  if (connectionIds) {
    connectionIds.forEach(connectionId => {
      const pair = connectionPair.get(connectionId);
      if (pair) {
        const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];
        if (otherSessionWs) {
          otherSessionWs.send(JSON.stringify({ type: "disconnect", connectionId: connectionId }));
        }
      }
      connectionPair.delete(connectionId);
      connectionToPair.delete(connectionId);
      connectionToChannel.delete(connectionId);
    });
  }

  // Clean up dual connection info
  const dualInfo = wsDualInfo.get(ws);
  if (dualInfo) {
    const dualPair = dualPairs.get(dualInfo.pairId);
    if (dualPair) {
      if (dualInfo.channelType === 'urllc') {
        dualPair.urllc = null;
      } else {
        dualPair.embb = null;
      }
      // If both connections are gone, remove the pair
      if (!dualPair.urllc && !dualPair.embb) {
        dualPairs.delete(dualInfo.pairId);
      }
    }
    wsDualInfo.delete(ws);
  }

  wsServerType.delete(ws);
  clients.delete(ws);
}

/**
 * Register a dual connection (either URLLC or eMBB channel)
 */
function onRegisterDual(ws: WebSocket, pairId: string, channelType: 'urllc' | 'embb'): void {
  console.log(`[DualHandler] Registering ${channelType} for pairId: ${pairId}`);
  
  // Get or create the dual pair
  let dualPair = dualPairs.get(pairId);
  if (!dualPair) {
    dualPair = { 
      urllc: null, embb: null, 
      connectionIdUrllc: null, connectionIdEmbb: null, 
      unityWsEmbb: null, unityWsUrllc: null,
      unityVideoConnectionId: null
    };
    dualPairs.set(pairId, dualPair);
  }
  
  // Register this WebSocket to the appropriate channel
  if (channelType === 'urllc') {
    dualPair.urllc = ws;
  } else {
    dualPair.embb = ws;
  }
  
  // Store reverse mapping
  wsDualInfo.set(ws, { pairId, channelType });
  
  // Send acknowledgment
  ws.send(JSON.stringify({ type: 'register-dual-ack', pairId, channelType }));
  
  // If both channels are now connected, notify both
  if (dualPair.urllc && dualPair.embb) {
    console.log(`[DualHandler] Dual pair complete for pairId: ${pairId}`);
    dualPair.urllc.send(JSON.stringify({ type: 'pair-complete', pairId }));
    dualPair.embb.send(JSON.stringify({ type: 'pair-complete', pairId }));
  }
}

/**
 * Handle connect message for dual connections
 * Now handles separate connectionIds for URLLC and eMBB
 * Only broadcasts connect to Unity servers on the SAME port/server
 */
function onConnectDual(ws: WebSocket, connectionId: string, pairId: string, channelType: 'urllc' | 'embb'): void {
  console.log(`[DualHandler] Connect on ${channelType} for connectionId: ${connectionId}, pairId: ${pairId}`);
  
  const dualPair = dualPairs.get(pairId);
  if (dualPair) {
    // Store the connectionId for this channel
    if (channelType === 'urllc') {
      dualPair.connectionIdUrllc = connectionId;
    } else {
      dualPair.connectionIdEmbb = connectionId;
    }
    // Map connectionId to pairId and channel
    connectionToPair.set(connectionId, pairId);
    connectionToChannel.set(connectionId, channelType);
  }
  
  // Continue with regular connection handling
  onConnect(ws, connectionId);
  
  // In public mode, broadcast connect to Unity servers on the SAME port only
  if (!isPrivate) {
    const myServerType = wsServerType.get(ws);
    console.log(`[DualHandler] Broadcasting connect to Unity servers for ${channelType} on ${myServerType} server`);
    
    clients.forEach((_v, k) => {
      if (k === ws) {
        return; // Skip self
      }
      
      // Only send to clients on the SAME server type
      const targetServerType = wsServerType.get(k);
      if (targetServerType !== myServerType) {
        return; // Skip clients on different server
      }
      
      // Check if target is a dual client (has pairId)
      const targetDualInfo = wsDualInfo.get(k);
      if (targetDualInfo && targetDualInfo.pairId === pairId) {
        return; // Skip the other channel of the same user
      }
      
      // This is a Unity server on the same port
      console.log(`[DualHandler] Sending connect to Unity ${channelType} for connectionId: ${connectionId}`);
      k.send(JSON.stringify({ 
        type: "connect", 
        connectionId: connectionId,
        pairId: pairId,
        channelType: channelType
      }));
      
      // Store Unity WebSocket reference for this channel
      if (dualPair && !targetDualInfo) {
        if (channelType === 'embb') {
          dualPair.unityWsEmbb = k;
          console.log(`[DualHandler] Found Unity eMBB server for pairId: ${pairId}`);
        } else {
          dualPair.unityWsUrllc = k;
          console.log(`[DualHandler] Found Unity URLLC server for pairId: ${pairId}`);
        }
      }
    });
  }
}

function onConnect(ws: WebSocket, connectionId: string): void {
  let polite = true;
  if (isPrivate) {
    if (connectionPair.has(connectionId)) {
      const pair = connectionPair.get(connectionId);

      if (pair[0] != null && pair[1] != null) {
        ws.send(JSON.stringify({ type: "error", message: `${connectionId}: This connection id is already used.` }));
        return;
      } else if (pair[0] != null) {
        connectionPair.set(connectionId, [pair[0], ws]);
      }
    } else {
      connectionPair.set(connectionId, [ws, null]);
      polite = false;
    }
  }

  const connectionIds = getOrCreateConnectionIds(ws);
  connectionIds.add(connectionId);
  ws.send(JSON.stringify({ type: "connect", connectionId: connectionId, polite: polite }));
}

function onDisconnect(ws: WebSocket, connectionId: string): void {
  const connectionIds = clients.get(ws);
  if (connectionIds) {
    connectionIds.delete(connectionId);
  }

  if (connectionPair.has(connectionId)) {
    const pair = connectionPair.get(connectionId);
    const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];
    if (otherSessionWs) {
      otherSessionWs.send(JSON.stringify({ type: "disconnect", connectionId: connectionId }));
    }
  }
  connectionPair.delete(connectionId);
  connectionToPair.delete(connectionId);
  connectionToChannel.delete(connectionId);
  ws.send(JSON.stringify({ type: "disconnect", connectionId: connectionId }));
}

/**
 * Handle offer for dual connection
 * - Offers from URLLC channel (client input) go to Unity server
 * - Unity server's offers for video should go to eMBB channel
 */
function onOfferDual(ws: WebSocket, message: any, pairId: string, channelType: 'urllc' | 'embb'): void {
  const connectionId = message.connectionId as string;
  const newOffer = new Offer(message.sdp, Date.now(), false);
  
  console.log(`[DualHandler] Offer received on ${channelType} for connectionId: ${connectionId}, pairId: ${pairId}`);
  
  const dualPair = dualPairs.get(pairId);
  
  if (isPrivate) {
    if (connectionPair.has(connectionId)) {
      const pair = connectionPair.get(connectionId);
      const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];
      if (otherSessionWs) {
        newOffer.polite = true;
        otherSessionWs.send(JSON.stringify({ 
          from: connectionId, 
          to: "", 
          type: "offer", 
          data: newOffer,
          pairId: pairId,
          channelType: channelType
        }));
      }
    }
    return;
  }

  connectionPair.set(connectionId, [ws, null]);
  connectionToPair.set(connectionId, pairId);
  connectionToChannel.set(connectionId, channelType);
  
  // Broadcast to all other clients (Unity servers) on the SAME port
  // Store reference to Unity server for later routing
  const myServerType = wsServerType.get(ws);
  
  clients.forEach((_v, k) => {
    if (k == ws) {
      return;
    }
    
    // Only route to Unity servers on the SAME port
    const targetServerType = wsServerType.get(k);
    if (targetServerType !== myServerType) {
      return;
    }
    
    // Check if this is a client WebSocket (has dual info)
    const targetDualInfo = wsDualInfo.get(k);
    if (targetDualInfo && targetDualInfo.pairId === pairId) {
      // Skip the other channel of the same user
      return;
    }
    
    // This is the Unity server on the same port
    if (dualPair && !targetDualInfo) {
      if (channelType === 'urllc') {
        dualPair.unityWsUrllc = k;
        console.log(`[DualHandler] Found Unity URLLC server for pairId: ${pairId}`);
      } else {
        dualPair.unityWsEmbb = k;
        console.log(`[DualHandler] Found Unity eMBB server for pairId: ${pairId}`);
      }
    }
    
    k.send(JSON.stringify({ 
      from: connectionId, 
      to: "", 
      type: "offer", 
      data: newOffer,
      pairId: pairId,
      channelType: channelType
    }));
  });
}

function onOffer(ws: WebSocket, message: any): void {
  // Check if this is a dual connection offer
  if (message.pairId) {
    onOfferDual(ws, message, message.pairId, message.channelType || 'urllc');
    return;
  }
  
  const connectionId = message.connectionId as string;
  const newOffer = new Offer(message.sdp, Date.now(), false);
  const sdp = message.sdp as string;
  const hasVideo = sdp && sdp.includes('m=video');
  const hasDataChannel = sdp && sdp.includes('m=application');
  
  // Determine which server (eMBB or URLLC) this offer came from
  const serverType = wsServerType.get(ws);
  console.log(`[DualHandler] Offer from ${serverType} server, connectionId: ${connectionId}, hasVideo: ${hasVideo}, hasDataChannel: ${hasDataChannel}`);

  if (isPrivate) {
    if (connectionPair.has(connectionId)) {
      const pair = connectionPair.get(connectionId);
      const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];
      if (otherSessionWs) {
        newOffer.polite = true;
        otherSessionWs.send(JSON.stringify({ from: connectionId, to: "", type: "offer", data: newOffer }));
      }
    }
    return;
  }

  connectionPair.set(connectionId, [ws, null]);
  
  // First try to find pairId by connectionId
  let pairId = connectionToPair.get(connectionId);
  
  // If not found, try to find pairId by looking up which dual pair has this Unity WebSocket
  if (!pairId) {
    console.log(`[DualHandler] ConnectionId ${connectionId} not in connectionToPair, searching by Unity WebSocket`);
    dualPairs.forEach((dualPair, pid) => {
      if (!pairId && (dualPair.unityWsEmbb === ws || dualPair.unityWsUrllc === ws)) {
        pairId = pid;
        console.log(`[DualHandler] Found pairId ${pairId} by Unity WebSocket match`);
        // Map this Unity connectionId to the pairId for future lookups
        connectionToPair.set(connectionId, pairId);
      }
    });
  }
  
  if (pairId) {
    const dualPair = dualPairs.get(pairId);
    if (dualPair) {
      if (hasVideo && dualPair.embb) {
        // Video offer from Unity eMBB - send to browser eMBB channel
        dualPair.unityVideoConnectionId = connectionId;
        connectionToChannel.set(connectionId, 'embb');
        
        // Filter SDP to only include eMBB IP candidates
        const filteredSdp = filterSdpCandidates(message.sdp, EMBB_IP);
        const filteredOffer = new Offer(filteredSdp, Date.now(), false);
        
        console.log(`[DualHandler] Routing video offer to eMBB browser (filtered for ${EMBB_IP}) for connectionId: ${connectionId}, pairId: ${pairId}`);
        
        dualPair.embb.send(JSON.stringify({ 
          from: connectionId, 
          to: "", 
          type: "offer", 
          data: filteredOffer,
          channelType: 'embb'
        }));
        return;
      } else if (hasDataChannel && dualPair.urllc) {
        // DataChannel offer - send to browser URLLC channel
        connectionToChannel.set(connectionId, 'urllc');
        
        // Filter SDP to only include URLLC IP candidates
        const filteredSdp = filterSdpCandidates(message.sdp, URLLC_IP);
        const filteredOffer = new Offer(filteredSdp, Date.now(), false);
        
        console.log(`[DualHandler] Routing DataChannel offer to URLLC browser (filtered for ${URLLC_IP}) for connectionId: ${connectionId}, pairId: ${pairId}`);
        
        dualPair.urllc.send(JSON.stringify({ 
          from: connectionId, 
          to: "", 
          type: "offer", 
          data: filteredOffer,
          channelType: 'urllc'
        }));
        return;
      }
    }
  }
  
  // Fallback: broadcast to all clients on the same server
  console.log(`[DualHandler] Fallback: broadcasting offer to all clients on ${serverType} server`);
  clients.forEach((_v, k) => {
    if (k == ws) {
      return;
    }
    // Only send to clients on the same server type
    if (wsServerType.get(k) === serverType) {
      k.send(JSON.stringify({ from: connectionId, to: "", type: "offer", data: newOffer }));
    }
  });
}

/**
 * Handle answer for dual connection
 * - Answers from URLLC channel go to Unity server
 * - Answers from Unity should go back to appropriate client channel
 */
function onAnswerDual(ws: WebSocket, message: any, pairId: string, channelType: 'urllc' | 'embb'): void {
  const connectionId = message.connectionId as string;
  const newAnswer = new Answer(message.sdp, Date.now());
  
  console.log(`[DualHandler] Answer received on ${channelType} for connectionId: ${connectionId}, pairId: ${pairId}`);
  
  const dualPair = dualPairs.get(pairId);
  
  if (!connectionPair.has(connectionId)) {
    return;
  }

  const pair = connectionPair.get(connectionId);
  const connectionIds = getOrCreateConnectionIds(ws);
  connectionIds.add(connectionId);
  
  if (!isPrivate) {
    connectionPair.set(connectionId, [pair[0], ws]);
  }
  
  // Route answer to appropriate Unity server based on channel type
  let unityServer: WebSocket | null = null;
  if (dualPair) {
    unityServer = channelType === 'urllc' ? dualPair.unityWsUrllc : dualPair.unityWsEmbb;
  }
  if (!unityServer) {
    unityServer = pair[0];
  }
  
  if (unityServer && unityServer !== ws) {
    console.log(`[DualHandler] Routing ${channelType} answer to Unity ${channelType} server`);
    unityServer.send(JSON.stringify({ from: connectionId, to: "", type: "answer", data: newAnswer }));
  } else {
    console.log(`[DualHandler] Warning: Could not find Unity server to route ${channelType} answer`);
  }
}

function onAnswer(ws: WebSocket, message: any): void {
  // Check if this is a dual connection answer
  if (message.pairId) {
    onAnswerDual(ws, message, message.pairId, message.channelType || 'urllc');
    return;
  }
  
  const connectionId = message.connectionId as string;
  const connectionIds = getOrCreateConnectionIds(ws);
  connectionIds.add(connectionId);
  const newAnswer = new Answer(message.sdp, Date.now());

  if (!connectionPair.has(connectionId)) {
    return;
  }

  const pair = connectionPair.get(connectionId);
  
  // Check if this is from Unity server - route to client's appropriate channel
  const pairId = connectionToPair.get(connectionId);
  if (pairId) {
    const dualPair = dualPairs.get(pairId);
    if (dualPair) {
      // Determine which channel to use based on connectionId
      if (connectionId === dualPair.connectionIdUrllc && dualPair.urllc) {
        // Filter SDP for URLLC - only keep 192.168.56.115 candidates
        const filteredSdp = filterSdpCandidates(message.sdp, URLLC_IP);
        const filteredAnswer = new Answer(filteredSdp, Date.now());
        console.log(`[DualHandler] Routing answer to URLLC channel (filtered for ${URLLC_IP}) for connectionId: ${connectionId}`);
        dualPair.urllc.send(JSON.stringify({ from: connectionId, to: "", type: "answer", data: filteredAnswer, channelType: 'urllc' }));
        if (!isPrivate) {
          connectionPair.set(connectionId, [ws, dualPair.urllc]);
        }
        return;
      } else if (connectionId === dualPair.connectionIdEmbb && dualPair.embb) {
        // Filter SDP for eMBB - only keep 192.168.56.114 candidates
        const filteredSdp = filterSdpCandidates(message.sdp, EMBB_IP);
        const filteredAnswer = new Answer(filteredSdp, Date.now());
        console.log(`[DualHandler] Routing answer to eMBB channel (filtered for ${EMBB_IP}) for connectionId: ${connectionId}`);
        dualPair.embb.send(JSON.stringify({ from: connectionId, to: "", type: "answer", data: filteredAnswer, channelType: 'embb' }));
        if (!isPrivate) {
          connectionPair.set(connectionId, [ws, dualPair.embb]);
        }
        return;
      }
    }
  }
  
  // Fallback
  const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];
  if (!isPrivate) {
    connectionPair.set(connectionId, [otherSessionWs, ws]);
  }
  if (otherSessionWs) {
    otherSessionWs.send(JSON.stringify({ from: connectionId, to: "", type: "answer", data: newAnswer }));
  }
}

/**
 * Handle ICE candidate for dual connection
 */
function onCandidateDual(ws: WebSocket, message: any, pairId: string, channelType: 'urllc' | 'embb'): void {
  const connectionId = message.connectionId;
  
  // Skip empty candidates (end-of-candidates signal)
  if (!message.candidate || message.candidate === '') {
    console.log(`[DualHandler] Skipping empty candidate (end-of-candidates) for connectionId: ${connectionId}`);
    return;
  }
  
  const candidate = new Candidate(message.candidate, message.sdpMLineIndex, message.sdpMid, Date.now());
  
  console.log(`[DualHandler] Candidate received on ${channelType} for connectionId: ${connectionId}`);
  
  const dualPair = dualPairs.get(pairId);

  if (isPrivate) {
    if (connectionPair.has(connectionId)) {
      const pair = connectionPair.get(connectionId);
      const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];
      if (otherSessionWs) {
        otherSessionWs.send(JSON.stringify({ 
          from: connectionId, 
          to: "", 
          type: "candidate", 
          data: candidate,
          pairId: pairId,
          channelType: channelType
        }));
      }
    }
    return;
  }

  // Route candidates to appropriate Unity server based on channel
  let unityServer: WebSocket | null = null;
  if (dualPair) {
    unityServer = channelType === 'urllc' ? dualPair.unityWsUrllc : dualPair.unityWsEmbb;
  }
  
  if (unityServer) {
    console.log(`[DualHandler] Routing ${channelType} candidate to Unity ${channelType} server`);
    unityServer.send(JSON.stringify({ from: connectionId, to: "", type: "candidate", data: candidate }));
    return;
  }

  // Fallback: broadcast to others on same server type
  const myServerType = wsServerType.get(ws);
  clients.forEach((_v, k) => {
    if (k === ws) {
      return;
    }
    // Only route to same server type
    const targetServerType = wsServerType.get(k);
    if (targetServerType !== myServerType) {
      return;
    }
    const targetDualInfo = wsDualInfo.get(k);
    if (targetDualInfo && targetDualInfo.pairId === pairId) {
      // Skip the other channel of the same user
      return;
    }
    k.send(JSON.stringify({ from: connectionId, to: "", type: "candidate", data: candidate }));
  });
}

function onCandidate(ws: WebSocket, message: any): void {
  // Check if this is a dual connection candidate
  if (message.pairId) {
    onCandidateDual(ws, message, message.pairId, message.channelType || 'urllc');
    return;
  }
  
  const connectionId = message.connectionId;
  
  // Skip empty candidates (end-of-candidates signal)
  if (!message.candidate || message.candidate === '') {
    console.log(`[DualHandler] Skipping empty candidate (end-of-candidates) for connectionId: ${connectionId}`);
    return;
  }
  
  // Check if this is from Unity server - route to client's appropriate channel
  const pairId = connectionToPair.get(connectionId);
  if (pairId) {
    const dualPair = dualPairs.get(pairId);
    if (dualPair) {
      // Check tracked channel type for this connectionId
      const trackedChannel = connectionToChannel.get(connectionId);
      
      // Determine the target channel and apply IP filtering
      let targetChannel: 'urllc' | 'embb' | null = null;
      
      // If this is the Unity video connectionId, route to eMBB
      if (connectionId === dualPair.unityVideoConnectionId) {
        targetChannel = 'embb';
      } else if (connectionId === dualPair.connectionIdUrllc) {
        targetChannel = 'urllc';
      } else if (connectionId === dualPair.connectionIdEmbb) {
        targetChannel = 'embb';
      } else if (trackedChannel) {
        targetChannel = trackedChannel;
      }
      
      if (targetChannel) {
        // Apply IP filtering based on channel type
        const allowedIP = targetChannel === 'urllc' ? URLLC_IP : EMBB_IP;
        if (!filterCandidateByIP(message.candidate, allowedIP)) {
          console.log(`[DualHandler] Filtering ${targetChannel} candidate (not ${allowedIP}): ${message.candidate.substring(0, 60)}...`);
          return;
        }
        
        const candidate = new Candidate(message.candidate, message.sdpMLineIndex, message.sdpMid, Date.now());
        const targetWs = targetChannel === 'urllc' ? dualPair.urllc : dualPair.embb;
        
        if (targetWs) {
          console.log(`[DualHandler] Routing ${targetChannel} candidate (${allowedIP}) for connectionId: ${connectionId}`);
          targetWs.send(JSON.stringify({ from: connectionId, to: "", type: "candidate", data: candidate, channelType: targetChannel }));
          return;
        }
      }
    }
  }

  // Fallback for non-dual connections
  const candidate = new Candidate(message.candidate, message.sdpMLineIndex, message.sdpMid, Date.now());

  if (isPrivate) {
    if (connectionPair.has(connectionId)) {
      const pair = connectionPair.get(connectionId);
      const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];
      if (otherSessionWs) {
        otherSessionWs.send(JSON.stringify({ from: connectionId, to: "", type: "candidate", data: candidate }));
      }
    }
    return;
  }

  // Fallback
  clients.forEach((_v, k) => {
    if (k === ws) {
      return;
    }
    k.send(JSON.stringify({ from: connectionId, to: "", type: "candidate", data: candidate }));
  });
}

// Export dual connection handlers
export { 
  reset, 
  add, 
  remove, 
  onConnect, 
  onDisconnect, 
  onOffer, 
  onAnswer, 
  onCandidate,
  onRegisterDual,
  onConnectDual
};

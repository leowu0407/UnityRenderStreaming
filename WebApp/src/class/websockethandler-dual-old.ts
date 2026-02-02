import Offer from './offer';
import Answer from './answer';
import Candidate from './candidate';

let isPrivate: boolean;

// [{sessionId:[connectionId,...]}]
const clients: Map<WebSocket, Set<string>> = new Map<WebSocket, Set<string>>();

// [{connectionId:[sessionId1, sessionId2]}]
const connectionPair: Map<string, [WebSocket, WebSocket]> = new Map<string, [WebSocket, WebSocket]>();

// Dual connection support:
// Maps pairId to the two WebSocket connections (urllc and embb)
interface DualPair {
  urllc: WebSocket | null;
  embb: WebSocket | null;
  connectionId: string | null;
}
const dualPairs: Map<string, DualPair> = new Map<string, DualPair>();

// Maps WebSocket to its dual pair info
interface DualConnectionInfo {
  pairId: string;
  channelType: 'urllc' | 'embb';
}
const wsDualInfo: Map<WebSocket, DualConnectionInfo> = new Map<WebSocket, DualConnectionInfo>();

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

function add(ws: WebSocket): void {
  clients.set(ws, new Set<string>());
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
    dualPair = { urllc: null, embb: null, connectionId: null };
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
 */
function onConnectDual(ws: WebSocket, connectionId: string, pairId: string, channelType: 'urllc' | 'embb'): void {
  console.log(`[DualHandler] Connect on ${channelType} for connectionId: ${connectionId}, pairId: ${pairId}`);
  
  const dualPair = dualPairs.get(pairId);
  if (dualPair) {
    dualPair.connectionId = connectionId;
  }
  
  // Continue with regular connection handling
  onConnect(ws, connectionId);
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
  ws.send(JSON.stringify({ type: "disconnect", connectionId: connectionId }));
}

/**
 * Handle offer for dual connection - route response through eMBB channel
 */
function onOfferDual(ws: WebSocket, message: any, pairId: string): void {
  const connectionId = message.connectionId as string;
  const newOffer = new Offer(message.sdp, Date.now(), false);
  
  console.log(`[DualHandler] Offer received on URLLC for connectionId: ${connectionId}, pairId: ${pairId}`);
  
  const dualPair = dualPairs.get(pairId);
  
  if (isPrivate) {
    if (connectionPair.has(connectionId)) {
      const pair = connectionPair.get(connectionId);
      const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];
      if (otherSessionWs) {
        newOffer.polite = true;
        // For dual mode: the Unity server should respond through the eMBB channel
        // Store info so we can route the answer correctly
        otherSessionWs.send(JSON.stringify({ 
          from: connectionId, 
          to: "", 
          type: "offer", 
          data: newOffer,
          pairId: pairId,
          responseChannel: 'embb'  // Indicate response should go to eMBB
        }));
      }
    }
    return;
  }

  connectionPair.set(connectionId, [ws, null]);
  
  // In public mode, broadcast to all other clients
  clients.forEach((_v, k) => {
    if (k == ws) {
      return;
    }
    // Check if this is the paired eMBB connection for the same pairId
    const targetDualInfo = wsDualInfo.get(k);
    if (targetDualInfo && targetDualInfo.pairId === pairId) {
      // Skip the paired eMBB connection of the same user
      return;
    }
    k.send(JSON.stringify({ 
      from: connectionId, 
      to: "", 
      type: "offer", 
      data: newOffer,
      pairId: pairId 
    }));
  });
}

function onOffer(ws: WebSocket, message: any): void {
  // Check if this is a dual connection offer
  if (message.pairId) {
    onOfferDual(ws, message, message.pairId);
    return;
  }
  
  const connectionId = message.connectionId as string;
  const newOffer = new Offer(message.sdp, Date.now(), false);

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
  clients.forEach((_v, k) => {
    if (k == ws) {
      return;
    }
    k.send(JSON.stringify({ from: connectionId, to: "", type: "offer", data: newOffer }));
  });
}

/**
 * Handle answer for dual connection - route to the Unity server (pair[0])
 * The answer comes from client (via URLLC) and should go to Unity server
 */
function onAnswerDual(ws: WebSocket, message: any, pairId: string): void {
  const connectionId = message.connectionId as string;
  const newAnswer = new Answer(message.sdp, Date.now());
  
  console.log(`[DualHandler] Answer received for connectionId: ${connectionId}, pairId: ${pairId}`);
  
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
  
  // For dual connection: Send answer to Unity server (pair[0]), not back to client
  // The Unity server is the one that sent the offer (pair[0])
  const unityServer = pair[0];
  if (unityServer && unityServer !== ws) {
    console.log(`[DualHandler] Routing answer to Unity server`);
    unityServer.send(JSON.stringify({ from: connectionId, to: "", type: "answer", data: newAnswer }));
  } else {
    console.log(`[DualHandler] Warning: Could not find Unity server to route answer`);
  }
}

function onAnswer(ws: WebSocket, message: any): void {
  // Check if this is a dual connection answer
  if (message.pairId) {
    onAnswerDual(ws, message, message.pairId);
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
  const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];

  if (!isPrivate) {
    connectionPair.set(connectionId, [otherSessionWs, ws]);
  }

  otherSessionWs.send(JSON.stringify({ from: connectionId, to: "", type: "answer", data: newAnswer }));
}

/**
 * Handle ICE candidate for dual connection
 */
function onCandidateDual(ws: WebSocket, message: any, pairId: string, channelType: 'urllc' | 'embb'): void {
  const connectionId = message.connectionId;
  const candidate = new Candidate(message.candidate, message.sdpMLineIndex, message.sdpMid, Date.now());
  
  console.log(`[DualHandler] Candidate received on ${channelType} for connectionId: ${connectionId}`);
  
  const dualPair = dualPairs.get(pairId);

  if (isPrivate) {
    if (connectionPair.has(connectionId)) {
      const pair = connectionPair.get(connectionId);
      const otherSessionWs = pair[0] == ws ? pair[1] : pair[0];
      if (otherSessionWs) {
        // For dual: route candidates appropriately
        // Candidates from URLLC go to Unity, responses come back on eMBB
        otherSessionWs.send(JSON.stringify({ 
          from: connectionId, 
          to: "", 
          type: "candidate", 
          data: candidate,
          pairId: pairId,
          responseChannel: channelType === 'urllc' ? 'embb' : 'urllc'
        }));
      }
    }
    return;
  }

  // Public mode - broadcast to others
  clients.forEach((_v, k) => {
    if (k === ws) {
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

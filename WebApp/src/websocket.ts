import * as websocket from "ws";
import { Server } from 'http';
import * as handler from "./class/websockethandler";
import * as dualHandler from "./class/websockethandler-dual";

export default class WSSignaling {
  server: Server;
  wss: websocket.Server;
  useDualMode: boolean;
  serverType: 'embb' | 'urllc';

  constructor(server: Server, mode: string, useDualMode: boolean = false, serverType: 'embb' | 'urllc' = 'embb') {
    this.server = server;
    this.wss = new websocket.Server({ server });
    this.useDualMode = useDualMode;
    this.serverType = serverType;
    
    if (useDualMode) {
      dualHandler.reset(mode);
      console.log(`[WSSignaling] Running in dual-connection mode as ${serverType} server`);
    } else {
      handler.reset(mode);
    }

    this.wss.on('connection', (ws: WebSocket) => {

      if (this.useDualMode) {
        dualHandler.add(ws, this.serverType);
        console.log(`[WSSignaling] New ${this.serverType} connection added`);
      } else {
        handler.add(ws);
      }

      ws.onclose = (): void => {
        if (this.useDualMode) {
          dualHandler.remove(ws);
        } else {
          handler.remove(ws);
        }
      };

      ws.onmessage = (event: MessageEvent): void => {

        // type: connect, disconnect JSON Schema
        // connectionId: connect or disconnect connectionId

        // type: offer, answer, candidate JSON Schema
        // from: from connection id
        // to: to connection id
        // data: any message data structure

        // Dual connection additional fields:
        // pairId: unique identifier linking urllc and embb connections
        // channelType: 'urllc' or 'embb'

        const msg = JSON.parse(event.data);
        if (!msg || !this) {
          return;
        }

        console.log(msg);

        // Handle dual connection registration
        if (msg.type === "register-dual") {
          dualHandler.onRegisterDual(ws, msg.pairId, msg.channelType);
          return;
        }

        // Use appropriate handler based on mode
        const activeHandler = this.useDualMode ? dualHandler : handler;

        switch (msg.type) {
          case "connect":
            if (this.useDualMode && msg.pairId) {
              dualHandler.onConnectDual(ws, msg.connectionId, msg.pairId, msg.channelType);
            } else {
              activeHandler.onConnect(ws, msg.connectionId);
            }
            break;
          case "disconnect":
            activeHandler.onDisconnect(ws, msg.connectionId);
            break;
          case "offer":
            // Pass pairId info if present
            if (msg.pairId) {
              msg.data.pairId = msg.pairId;
              msg.data.channelType = msg.channelType;
            }
            activeHandler.onOffer(ws, msg.data);
            break;
          case "answer":
            if (msg.pairId) {
              msg.data.pairId = msg.pairId;
              msg.data.channelType = msg.channelType;
            }
            activeHandler.onAnswer(ws, msg.data);
            break;
          case "candidate":
            if (msg.pairId) {
              msg.data.pairId = msg.pairId;
              msg.data.channelType = msg.channelType;
            }
            activeHandler.onCandidate(ws, msg.data);
            break;
          default:
            break;
        }
      };
    });
  }
}

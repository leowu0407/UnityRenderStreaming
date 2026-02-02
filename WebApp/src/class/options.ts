export default interface Options {
  secure?: boolean;
  port?: number;
  keyfile?: string;
  certfile?: string;
  type?: string;
  mode?: string;
  logging?: string;
  dual?: boolean;      // Enable dual-connection mode for URLLC+eMBB architecture
  dualPort?: number;   // Second port for dual mode (URLLC)
}

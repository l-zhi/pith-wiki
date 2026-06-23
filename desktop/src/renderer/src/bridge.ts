import {
  makeBridgeClient,
  type BridgeClient,
  type BridgeMessage,
  type Transport,
} from '../../shared/protocol';

/** window.pith（preload contextBridge）→ EngineBridge client 单例。 */
const transport: Transport = {
  post: (msg: BridgeMessage) => window.pith.post(msg),
  onMessage: (cb) => window.pith.onMessage((msg) => cb(msg as BridgeMessage)),
};

export const bridge: BridgeClient = makeBridgeClient(transport);

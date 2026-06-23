/** renderer 侧的 window.pith 类型（preload contextBridge 暴露）。 */
export {};

declare global {
  interface Window {
    pith: {
      post(msg: unknown): void;
      onMessage(cb: (msg: unknown) => void): void;
      openSource(target: string): Promise<{ ok: boolean; error?: string }>;
      copyText(text: string): void;
      pickFolder(): Promise<string | null>;
    };
  }
}

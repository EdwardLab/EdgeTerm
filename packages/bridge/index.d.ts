export const EDGETERM_BRIDGE_PROTOCOL: "edgeterm.bridge.v3";
export const EDGETERM_BRIDGE_VERSION: "3.0.0";

export type EdgeTermBridgeEvent = {
  protocol: typeof EDGETERM_BRIDGE_PROTOCOL;
  session_id: string;
  kind: "event";
  event: string;
  data: unknown;
};

export class EdgeTermBridgeError extends Error {
  code: string;
  recoverable: boolean;
  requestId: string;
  idempotencyKey: string;
  details: Record<string, unknown> | null;
  constructor(
    message: string,
    code?: string,
    options?: {
      recoverable?: boolean;
      requestId?: string;
      idempotencyKey?: string;
      details?: Record<string, unknown> | null;
    },
  );
}

export class EdgeTermBridgeClient extends EventTarget {
  constructor(options: {
    iframe: HTMLIFrameElement;
    targetOrigin: string;
    timeoutMs?: number;
  });
  readonly iframe: HTMLIFrameElement;
  readonly targetOrigin: string;
  readonly timeoutMs: number;
  readonly sessionId: string;
  readonly capabilities: Record<string, unknown>;
  connect(): Promise<{
    bridge_version: string;
    runtime_version: string;
    capabilities: Record<string, unknown>;
  }>;
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  setHostRequestHandler(
    handler:
      | ((method: string, params: Record<string, unknown>) => Promise<unknown> | unknown)
      | null,
  ): void;
  close(): void;
}

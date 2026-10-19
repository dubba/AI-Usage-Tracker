/** One animated-QR frame of an air-gap transfer: `aiut-airgap://[1/]<session>/<n>/<total>/<hex>?d=<data>`. */
export interface AirgapFrame {
  sessionId: string;
  /** 1-based position of this frame. */
  chunkIndex: number;
  totalChunks: number;
}

const AIRGAP_FRAME = /aiut-airgap:\/\/(?:1\/)?([^/]+)\/(\d+)\/(\d+)\/([0-9a-fA-F]+)\?d=(.+)/;

/** Whether `code` is the start of an air-gap frame (`aiut-airgap:`), whether or not it is well formed. */
export function isAirgapFrameCode(code: string): boolean {
  return code.startsWith("aiut-airgap:");
}

/** The frame's session and position, or null when it is malformed or its numbers are not positive. */
export function parseAirgapFrame(code: string): AirgapFrame | null {
  if (!isAirgapFrameCode(code)) return null;
  const match = AIRGAP_FRAME.exec(code);
  if (!match) return null;
  const [, sessionId, chunk, total] = match;
  const chunkIndex = parseInt(chunk, 10);
  const totalChunks = parseInt(total, 10);
  if (!(chunkIndex > 0 && totalChunks > 0)) return null;
  return { sessionId, chunkIndex, totalChunks };
}

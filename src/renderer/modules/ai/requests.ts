/** Requests for the AI Studio from other modules; kept until a studio is mounted to take them. */
export interface AIRequest {
  prompt: string;
  context?: Record<string, unknown>;
  mode?: 'build' | 'plan' | 'ask';
  send?: boolean;
}

let pending: AIRequest | null = null;
const listeners = new Set<(r: AIRequest) => void>();

export function requestAI(r: AIRequest): void {
  if (listeners.size) for (const l of listeners) l(r);
  else pending = r;
}

export function onAIRequest(l: (r: AIRequest) => void): () => void {
  listeners.add(l);
  if (pending) {
    const p = pending;
    pending = null;
    l(p);
  }
  return () => {
    listeners.delete(l);
  };
}

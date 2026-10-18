import type {
  ChapterContext,
  Health,
  StreamEvent,
  ThreadDetail,
  ThreadGroup,
  TreeResponse,
} from "@/lib/types";

/** Port the FastAPI backend is published on (docker-compose maps 8000:8000). */
const API_PORT = 8000;

/**
 * Resolve the API base URL when a request is made, rather than baking it in.
 *
 * `NEXT_PUBLIC_*` values are inlined by `next build`, so a build-time host keeps
 * pointing at whatever address was configured then — a retired IP stays frozen in the
 * shipped bundle until the image is rebuilt. The web UI and the API are published from
 * the same host, so deriving the host from the page itself stays correct after an IP
 * change and in local development alike. An explicit NEXT_PUBLIC_API_BASE is still
 * honoured, which keeps split (separate-host) deployments working.
 */
function apiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE;
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  if (typeof window === "undefined") {
    return `http://127.0.0.1:${API_PORT}`;
  }
  return `${window.location.protocol}//${window.location.hostname}:${API_PORT}`;
}

/**
 * Stable per-browser identifier, persisted in localStorage and sent as `X-Client-Id`.
 * The API stores it on each thread and only ever returns threads owned by it, so two
 * browsers on the same server never see each other's history.
 */
const CLIENT_ID_KEY = "boibondhu.client_id";
let cachedClientId: string | null = null;

function clientId(): string {
  if (cachedClientId) {
    return cachedClientId;
  }
  if (typeof window === "undefined") {
    return (cachedClientId = "server");
  }
  try {
    const stored = window.localStorage.getItem(CLIENT_ID_KEY);
    if (stored) {
      return (cachedClientId = stored);
    }
    const created =
      window.crypto?.randomUUID?.() ??
      `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(CLIENT_ID_KEY, created);
    return (cachedClientId = created);
  } catch {
    // Storage can be unavailable (private mode); a per-session id still separates tabs.
    return (cachedClientId = `session-${Date.now().toString(36)}`);
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `অনুরোধ ব্যর্থ হয়েছে (HTTP ${response.status})`;
  }
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === "string") {
      return detail;
    }
    if (Array.isArray(detail)) {
      return detail
        .map((item) => {
          if (item && typeof item === "object" && "msg" in item) {
            return String((item as { msg: unknown }).msg);
          }
          return JSON.stringify(item);
        })
        .join("; ");
    }
  } catch {
    return text.slice(0, 300);
  }
  return text.slice(0, 300);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = apiBase();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": clientId(),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch (error) {
    throw new ApiError(
      `সার্ভারে সংযোগ করা যায়নি (${base})। ব্যাকএন্ড চালু আছে কি? ${error instanceof Error ? error.message : ""
        }`.trim(),
      0,
    );
  }
  if (!response.ok) {
    throw new ApiError(await readError(response), response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => request<Health>("/api/health"),
  tree: () => request<TreeResponse>("/api/tree"),
  threads: () => request<ThreadGroup[]>("/api/threads"),
  thread: (threadId: string) => request<ThreadDetail>(`/api/threads/${threadId}`),
  createThread: (context: ChapterContext) =>
    request<ThreadDetail>("/api/threads", {
      method: "POST",
      body: JSON.stringify({ context }),
    }),
  updateContext: (threadId: string, context: ChapterContext) =>
    request<ThreadDetail>(`/api/threads/${threadId}/context`, {
      method: "PUT",
      body: JSON.stringify({ context }),
    }),
  renameThread: (threadId: string, title: string) =>
    request<ThreadDetail>(`/api/threads/${threadId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteThread: (threadId: string) =>
    request<void>(`/api/threads/${threadId}`, { method: "DELETE" }),
};

/**
 * POSTs a question and yields parsed NDJSON events as they arrive.
 * NDJSON (one JSON object per line) is used instead of SSE because the request
 * carries a body and must surface errors mid-stream.
 */
export async function* streamChat(
  threadId: string,
  message: string,
  context: ChapterContext,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}/api/threads/${threadId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": clientId() },
      body: JSON.stringify({ message, context }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }
    throw new ApiError(
      `উত্তর আনার অনুরোধ পাঠানো যায়নি: ${error instanceof Error ? error.message : ""}`.trim(),
      0,
    );
  }

  if (!response.ok) {
    throw new ApiError(await readError(response), response.status);
  }
  if (!response.body) {
    throw new ApiError("সার্ভার থেকে কোনো স্ট্রিম পাওয়া যায়নি।", response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          yield JSON.parse(line) as StreamEvent;
        }
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) {
      yield JSON.parse(tail) as StreamEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

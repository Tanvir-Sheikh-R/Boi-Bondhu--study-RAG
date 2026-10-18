"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { SelectionModal, type PickerResult } from "@/components/selection-modal";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import { ChatComposer } from "@/components/chat-composer";
import { EmptyState } from "@/components/empty-state";
import { MessageList } from "@/components/message-list";
import { LoadingScreen, ToastStack, type Toast } from "@/components/toast";
import { ApiError, api, streamChat } from "@/lib/api";
import type {
  ChapterContext,
  ChatMessage,
  Health,
  ThreadDetail,
  ThreadGroup,
  TreeResponse,
} from "@/lib/types";
import { useUserName } from "@/lib/use-user-name";

type ModalState = {
  mode: "new" | "switch";
  initial: ChapterContext | null;
};

function toContext(detail: ThreadDetail): ChapterContext | null {
  const context = detail.context;
  if (
    !context.class_id ||
    !context.class_label ||
    !context.subject ||
    !context.subject_label ||
    !context.book ||
    !context.chapter
  ) {
    return null;
  }
  return {
    class_id: context.class_id,
    class_label: context.class_label,
    subject: context.subject,
    subject_label: context.subject_label,
    stream: context.stream ?? null,
    book: context.book,
    chapter: context.chapter,
  };
}

export default function Page() {
  const { userName, saveUserName } = useUserName();

  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [groups, setGroups] = useState<ThreadGroup[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [context, setContext] = useState<ChapterContext | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [statusLabel, setStatusLabel] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    threadId: string;
    title: string;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const toastIdRef = useRef(0);
  const pickerShownRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const pushToast = useCallback((tone: Toast["tone"], message: string) => {
    const id = ++toastIdRef.current;
    setToasts((current) => [...current, { id, tone, message }].slice(-3));
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const refreshThreads = useCallback(async () => {
    try {
      setGroups(await api.threads());
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "চ্যাট তালিকা লোড হয়নি।");
    } finally {
      setThreadsLoading(false);
    }
  }, [pushToast]);

  const bootstrap = useCallback(async () => {
    setThreadsLoading(true);
    const requestedThread =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("thread")
        : null;
    try {
      const [healthResponse, treeResponse] = await Promise.all([api.health(), api.tree()]);
      setHealth(healthResponse);
      setTree(treeResponse);
      setReady(true);
      if (requestedThread) {
        const detail = await api.thread(requestedThread);
        setActiveThreadId(detail.thread_id);
        setMessages(detail.messages);
        setContext(toContext(detail));
        pickerShownRef.current = true;
      }
      void refreshThreads();
    } catch (error) {
      setBootError(
        error instanceof ApiError
          ? error.message
          : "সার্ভারের সাথে সংযোগ করা যায়নি। ব্যাকএন্ড চালু আছে কি?",
      );
    } finally {
      setThreadsLoading(false);
    }
  }, [refreshThreads]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Requirement: the selection popup blocks the app until a class/subject/chapter
  // is chosen, so open it once the app is ready and no thread is loaded yet.
  useEffect(() => {
    if (!ready || pickerShownRef.current || modal || activeThreadId) {
      return;
    }
    pickerShownRef.current = true;
    setModal({ mode: "new", initial: null });
  }, [activeThreadId, modal, ready]);

  // Keep the newest content in view: new messages and every streamed chunk.
  useEffect(() => {
    const container = scrollRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages, streamingText, statusLabel]);

  const startThread = useCallback(
    async (nextContext: ChapterContext) => {
      const created = await api.createThread(nextContext);
      setActiveThreadId(created.thread_id);
      setMessages(created.messages);
      setContext(toContext(created) ?? nextContext);
      await refreshThreads();
    },
    [refreshThreads],
  );

  const handlePickerSubmit = useCallback(
    async ({ context: picked, startFresh }: PickerResult) => {
      const switchTarget = modal?.mode === "switch" ? activeThreadId : null;
      if (!startFresh && switchTarget) {
        const updated = await api.updateContext(switchTarget, picked);
        setContext(toContext(updated) ?? picked);
        await refreshThreads();
      } else {
        await startThread(picked);
      }
      setModal(null);
    },
    [activeThreadId, modal?.mode, refreshThreads, startThread],
  );

  const loadThread = useCallback(
    async (threadId: string) => {
      if (streaming) {
        return;
      }
      setThreadsLoading(true);
      try {
        const detail = await api.thread(threadId);
        setActiveThreadId(detail.thread_id);
        setMessages(detail.messages);
        setContext(toContext(detail));
        setStreamingText("");
        setStatusLabel(null);
        setNavOpen(false);
      } catch (error) {
        pushToast("error", error instanceof Error ? error.message : "চ্যাট লোড হয়নি।");
      } finally {
        setThreadsLoading(false);
      }
    },
    [pushToast, streaming],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      if (streaming) {
        pushToast("info", "উত্তর আসছে — শেষ হলে নাম বদলাতে পারবে।");
        return;
      }
      try {
        await api.renameThread(threadId, title);
        await refreshThreads();
      } catch (error) {
        pushToast("error", error instanceof Error ? error.message : "নাম বদলানো যায়নি।");
      }
    },
    [pushToast, refreshThreads, streaming],
  );

  // Deleting asks in-app rather than with window.confirm(): a suppressed native
  // dialog silently answers "no" (or "yes"), which is worse than no warning at all.
  const requestDeleteThread = useCallback(
    (threadId: string) => {
      if (streaming) {
        pushToast("info", "উত্তর আসছে — শেষ হলে চ্যাট মুছতে পারবে।");
        return;
      }
      const found = groups
        .flatMap((group) => group.threads)
        .find((thread) => thread.thread_id === threadId);
      setPendingDelete({ threadId, title: found?.title ?? "এই চ্যাট" });
    },
    [groups, pushToast, streaming],
  );

  const confirmDeleteThread = useCallback(async () => {
    const target = pendingDelete;
    if (!target) {
      return;
    }
    setPendingDelete(null);
    const wasActive = target.threadId === activeThreadId;
    try {
      await api.deleteThread(target.threadId);
      if (wasActive) {
        // Back to the greeting in the same chapter. The thread is created again only
        // when the next question is sent, so no empty look-alike thread reappears.
        setActiveThreadId(null);
        setMessages([]);
        setStreamingText("");
        setStatusLabel(null);
      }
      await refreshThreads();
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "চ্যাট মোছা যায়নি।");
    }
  }, [activeThreadId, pendingDelete, pushToast, refreshThreads]);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || streaming) {
      return;
    }
    if (!context) {
      pushToast("error", "আগে শ্রেণি, বিষয় ও অধ্যায় বেছে নাও।");
      return;
    }

    // After deleting the current chat (or before the first message) there is no thread
    // yet: create one now, with this question as its first turn, rather than eagerly
    // creating empty threads that clutter the sidebar.
    let threadId: string;
    if (activeThreadId) {
      threadId = activeThreadId;
    } else {
      try {
        const created = await api.createThread(context);
        threadId = created.thread_id;
        setActiveThreadId(threadId);
      } catch (error) {
        pushToast("error", error instanceof Error ? error.message : "নতুন চ্যাট শুরু করা যায়নি।");
        return;
      }
    }

    setInput("");
    setStreamingText("");
    setStatusLabel("পাঠ্যবই খোঁজা হচ্ছে...");
    setStreaming(true);
    setMessages((current) => [...current, { role: "user", content: question }]);

    const controller = new AbortController();
    abortRef.current = controller;
    let answer = "";
    let failed: string | null = null;

    try {
      for await (const event of streamChat(threadId, question, context, controller.signal)) {
        switch (event.type) {
          case "status":
            setStatusLabel(event.message);
            break;
          case "delta":
            answer += event.text;
            setStreamingText(answer);
            break;
          case "error":
            failed = event.message;
            break;
          case "done":
            break;
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        answer = answer || "⏹ থামানো হয়েছে।";
      } else {
        failed = error instanceof Error ? error.message : "উত্তর আনতে সমস্যা হয়েছে।";
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setStatusLabel(null);

      if (failed) {
        if (!answer) {
          answer = failed;
        }
        pushToast("error", failed);
      }
      if (answer) {
        setMessages((current) => [...current, { role: "assistant", content: answer }]);
      }
      setStreamingText("");
      void refreshThreads();
    }
  }, [activeThreadId, context, input, pushToast, refreshThreads, streaming]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const renameUser = useCallback(() => {
    const next = window.prompt("তোমার নাম কী?", userName);
    if (next !== null) {
      saveUserName(next);
    }
  }, [saveUserName, userName]);

  const openPicker = useCallback(
    (mode: "new" | "switch") => {
      if (streaming) {
        pushToast("info", "উত্তর আসছে — শেষ হলে অধ্যায় বদলাতে পারবে।");
        return;
      }
      setModal({ mode, initial: mode === "switch" ? context : null });
    },
    [context, pushToast, streaming],
  );

  // Home: back to the greeting for the current chapter. The next question starts a
  // fresh thread, so no empty thread is created just by landing here.
  const goHome = useCallback(() => {
    if (streaming) {
      pushToast("info", "উত্তর আসছে — শেষ হলে হোমে যেতে পারবে।");
      return;
    }
    if (!context) {
      openPicker("new");
      return;
    }
    setActiveThreadId(null);
    setMessages([]);
    setStreamingText("");
    setStatusLabel(null);
  }, [context, openPicker, pushToast, streaming]);

  if (bootError && !ready) {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className="max-w-md rounded-3xl bg-surface p-6 text-center card-shadow">
          <h1 className="text-lg font-bold text-ink">সার্ভারে সংযোগ করা যায়নি</h1>
          <p className="pt-2 text-sm leading-relaxed text-neutral-600">{bootError}</p>
          <p className="pt-2 text-xs text-muted">
            টার্মিনালে চালাও: <code>python -m backend.run</code>
          </p>
          <button
            type="button"
            onClick={() => {
              setBootError(null);
              void bootstrap();
            }}
            className="mt-5 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-800"
          >
            আবার চেষ্টা করো
          </button>
        </div>
      </main>
    );
  }

  if (!ready || !tree) {
    return <LoadingScreen label="পাঠ্যবই প্রস্তুত হচ্ছে..." />;
  }

  const contextLabel = context
    ? `${context.class_label} · ${context.subject_label} · ${context.chapter}`
    : null;
  const currentSubject = context
    ? tree.classes
        .flatMap((item) => item.subjects)
        .find((item) => item.book === context.book)
    : undefined;
  const bookHint =
    currentSubject && !currentSubject.indexed
      ? "এই বইটির সূচি (embedding) এখনো তৈরি হয়নি — প্রশ্ন করলে পুরো বই খোঁজার চেষ্টা করা হবে।"
      : null;

  const composer = (
    <ChatComposer
      value={input}
      busy={streaming}
      canStop={streaming}
      hint={contextLabel ?? undefined}
      onChange={setInput}
      onSend={() => void send()}
      onStop={stop}
    />
  );

  return (
    <main className="flex h-dvh gap-4 p-3 sm:p-4">
      <div
        className={`${navOpen ? "flex" : "hidden"} absolute inset-y-0 left-0 z-30 h-full lg:static lg:flex`}
      >
        <div className="h-full overflow-hidden rounded-3xl bg-surface app-shadow">
          <Sidebar
            userName={userName}
            groups={groups}
            activeThreadId={activeThreadId}
            search={search}
            loading={threadsLoading}
            health={health}
            counts={tree.counts}
            onSearchChange={setSearch}
            onSelectThread={(threadId) => void loadThread(threadId)}
            onHome={goHome}
            onRenameThread={(threadId, title) => void renameThread(threadId, title)}
            onDeleteThread={requestDeleteThread}
            onRenameUser={renameUser}
          />
        </div>
      </div>

      {navOpen ? (
        <button
          type="button"
          aria-label="সাইডবার বন্ধ করো"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-20 bg-neutral-900/20 lg:hidden"
        />
      ) : null}

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl bg-surface app-shadow">
        <TopBar
          userName={userName}
          context={context}
          onOpenPicker={() => openPicker("switch")}
          onNewChat={() => openPicker("new")}
          onToggleNav={() => setNavOpen((open) => !open)}
        />

        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState userName={userName} contextLabel={contextLabel} hint={bookHint}>
              {composer}
            </EmptyState>
          ) : (
            <MessageList
              messages={messages}
              streamingText={streamingText}
              statusLabel={statusLabel}
            />
          )}
        </div>

        {messages.length > 0 ? (
          <div className="mx-auto w-full max-w-3xl px-4 pb-4">{composer}</div>
        ) : null}
      </section>

      {modal ? (
        <SelectionModal
          classes={tree.classes}
          initialContext={modal.initial}
          mode={modal.mode}
          onCancel={() => setModal(null)}
          onSubmit={handlePickerSubmit}
        />
      ) : null}

      {pendingDelete ? (
        <div className="bb-fade-in fixed inset-0 z-50 grid place-items-center bg-neutral-900/30 p-4 backdrop-blur-sm">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="চ্যাট মুছে ফেলার নিশ্চিতকরণ"
            className="bb-slide-up w-full max-w-sm rounded-3xl bg-surface p-6 card-shadow"
          >
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-rose-50 text-rose-600">
                <Trash2 className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-bold text-ink">চ্যাটটি মুছে ফেলবেন?</h2>
                <p className="truncate pt-1 text-[13px] text-neutral-600">{pendingDelete.title}</p>
                <p className="pt-2 text-[12px] leading-relaxed text-muted">
                  এটি স্থায়ীভাবে মুছে যাবে এবং ফিরিয়ে আনা যাবে না।
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-full px-4 py-2 text-[13px] font-medium text-neutral-600 transition hover:bg-neutral-100"
              >
                বাতিল
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteThread()}
                className="rounded-full bg-rose-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-rose-700"
              >
                মুছে ফেলো
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {/* Contact the developer. Pinned to the window's bottom-right corner; kept
          small and flush to the edge so it clears the composer's send button.
          Inline SVG because lucide no longer ships brand icons. */}
      <a
        href="https://www.linkedin.com/in/tanvir-sheikh-r/"
        target="_blank"
        rel="noreferrer"
        title="ডেভেলপারের LinkedIn প্রোফাইল"
        aria-label="ডেভেলপারের LinkedIn প্রোফাইল"
        className="fixed right-1 bottom-1 z-40 grid size-14 place-items-center rounded-full border border-neutral-200 bg-white text-muted shadow-lg transition hover:border-accent/50 hover:text-accent-strong"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" className="size-6">
          <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3.2 9.25h3.56V21H3.2V9.25Zm6.1 0h3.41v1.6h.05a3.74 3.74 0 0 1 3.37-1.85c3.6 0 4.27 2.37 4.27 5.45V21h-3.56v-5.63c0-1.34-.03-3.07-1.87-3.07-1.87 0-2.16 1.46-2.16 2.97V21H9.3V9.25Z" />
        </svg>
      </a>
    </main>
  );
}

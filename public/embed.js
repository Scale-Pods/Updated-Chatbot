(function () {
  // Prevent multiple initializations
  if (window.__SCALEPODS_CHAT_LOADED__) return;
  window.__SCALEPODS_CHAT_LOADED__ = true;

  const React = window.React;
  const ReactDOM = window.ReactDOM;

  if (!React || !ReactDOM) {
    console.error(
      "[scalepods-chat] React and ReactDOM must be loaded before embed.js",
    );
    return;
  }

  const { useState, useEffect, useRef, useCallback } = React;

  // Inject styles. Sizes use id + class selectors with !important so a host
  // site's global `button { ... }` rules can't stretch or reshape the widget.
  if (!document.getElementById("scalepods-chat-styles")) {
    const style = document.createElement("style");
    style.id = "scalepods-chat-styles";
    style.textContent = `
      @keyframes scalepods-fadeIn {
        from { opacity: 0; transform: scale(0.8); }
        to { opacity: 1; transform: scale(1); }
      }

      @keyframes scalepods-slideIn {
        from { opacity: 0; transform: scale(0.9) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }

      @keyframes scalepods-messageSlide {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @keyframes scalepods-spin {
        to { transform: rotate(360deg); }
      }

      .scalepods-message-enter {
        animation: scalepods-messageSlide 0.3s ease;
      }

      .scalepods-spinner {
        animation: scalepods-spin 0.8s linear infinite;
      }

      /* Scoped resets: keep host page styles out of the widget. */
      #scalepods-chat-root,
      #scalepods-chat-root * {
        box-sizing: border-box;
      }

      #scalepods-chat-root button,
      #scalepods-chat-root input {
        font-family: inherit;
        -webkit-appearance: none;
        appearance: none;
      }

      #scalepods-chat-root .sp-btn-launcher,
      #scalepods-chat-root .sp-btn-icon,
      #scalepods-chat-root .sp-btn-send {
        min-width: 0 !important;
        min-height: 0 !important;
        padding: 0 !important;
        flex: 0 0 auto !important;
        border-radius: 9999px !important;
      }

      #scalepods-chat-root .sp-btn-launcher {
        width: 56px !important;
        height: 56px !important;
      }

      #scalepods-chat-root .sp-btn-icon {
        width: 32px !important;
        height: 32px !important;
      }

      #scalepods-chat-root .sp-btn-send {
        width: 40px !important;
        height: 40px !important;
      }

      #scalepods-chat-root .sp-input::placeholder {
        color: #a1a1a1;
      }

      /* Custom scrollbar for dark theme */
      .scalepods-messages::-webkit-scrollbar {
        width: 6px;
      }

      .scalepods-messages::-webkit-scrollbar-track {
        background: #0a0a0a;
      }

      .scalepods-messages::-webkit-scrollbar-thumb {
        background: #2a2a2a;
        border-radius: 3px;
      }

      .scalepods-messages::-webkit-scrollbar-thumb:hover {
        background: #3a3a3a;
      }
    `;
    document.head.appendChild(style);
  }

  // Resolve this app's origin from the embed script itself so the widget works
  // on third-party sites. The real n8n URLs stay on the server, behind these
  // proxy routes, and are never shipped in this file.
  const API_BASE_URL = (() => {
    const script =
      document.currentScript || document.querySelector('script[src*="embed.js"]');
    if (script && script.src) {
      try {
        return new URL(script.src).origin;
      } catch (error) {
        // Fall through to the page origin below.
      }
    }
    return window.location.origin;
  })();

  const SEND_URL = `${API_BASE_URL}/api/chat/send`;
  const MESSAGES_URL = `${API_BASE_URL}/api/chat/messages`;
  const LOGO_URL = `${API_BASE_URL}/images/scalepods-logo.png`;
  const SESSION_EXPIRY_MS = 12 * 60 * 60 * 1000;

  // Adaptive polling: fast while the conversation is active, slower when idle,
  // with exponential backoff on errors and a full pause while the tab is hidden.
  const POLLING_FAST_INTERVAL_MS = 3 * 1000;
  const POLLING_IDLE_INTERVAL_MS = 12 * 1000;
  const POLLING_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
  const POLLING_MAX_BACKOFF_MS = 60 * 1000;

  const translations = {
    en: {
      welcome: "Welcome to Scalepods AI!",
      question: "How can we help you today?",
      agentMode: "Agent Mode",
      online: "Online",
      typing: "Typing...",
      agentLabel: "Agent",
      aiLabel: "AI",
      userPlaceholder: "Type your message…",
      agentPlaceholder: "Type agent reply…",
      closeAriaLabel: "Close chat",
      openAriaLabel: "Open chat",
      expandAriaLabel: "Expand chat",
      minimizeAriaLabel: "Minimize chat",
      sendAriaLabel: "Send message",
    },
    ar: {
      welcome: "مرحبًا بك في Scalepods AI!",
      question: "كيف يمكننا مساعدتك اليوم؟",
      agentMode: "وضع الوكيل",
      online: "متصل",
      typing: "جاري الكتابة...",
      agentLabel: "وكيل",
      aiLabel: "ذكاء اصطناعي",
      userPlaceholder: "اكتب رسالتك…",
      agentPlaceholder: "اكتب رد الوكيل…",
      closeAriaLabel: "إغلاق الدردشة",
      openAriaLabel: "فتح الدردشة",
      expandAriaLabel: "توسيع الدردشة",
      minimizeAriaLabel: "تصغير الدردشة",
      sendAriaLabel: "إرسال الرسالة",
    },
  };

  function detectLanguage() {
    const browserLang = navigator.language || "en";
    return browserLang.startsWith("ar") ? "ar" : "en";
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // Ignore storage errors (private mode, quota, etc.)
    }
  }

  function removeStorage(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      // Ignore storage errors
    }
  }

  // Lucide-style icons, rendered as inline SVG so no icon font is required.
  function icon(paths, size) {
    return React.createElement(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
      paths.map((d, index) => React.createElement("path", { key: index, d })),
    );
  }

  const MessageCircleIcon = (size) =>
    icon(["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"], size);

  const MaximizeIcon = (size) =>
    icon(["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"], size);

  const MinimizeIcon = (size) =>
    icon(["M4 14h6v6", "M20 10h-6V4", "m14 10 7-7", "m3 21 7-7"], size);

  const CloseIcon = (size) => icon(["M18 6 6 18", "m6 6 12 12"], size);

  const SendIcon = (size) => icon(["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"], size);

  function ChatWidget() {
    const [isOpen, setIsOpen] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [sessionId, setSessionId] = useState("");
    const [isAgentMode, setIsAgentMode] = useState(false);
    const [lang] = useState(() => detectLanguage());

    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const lastMessageIdRef = useRef(null);
    // Last time the user interacted or a new message arrived. Keeps polling fast
    // while the conversation is active, then lets it fall back to the idle rate.
    const lastActivityRef = useRef(Date.now());
    // Consecutive failed polls, used for exponential backoff.
    const pollFailuresRef = useRef(0);
    // Names of agents we've already announced as connected in this session.
    const announcedAgentsRef = useRef(new Set());

    const t = translations[lang];

    const initializeSession = useCallback(() => {
      const storedSessionId = readStorage("scalepods_session_id");
      const storedCreatedAt = readStorage("scalepods_session_created_at");
      const now = Date.now();

      if (storedSessionId && storedCreatedAt) {
        const createdAt = parseInt(storedCreatedAt, 10);
        if (Number.isFinite(createdAt) && now - createdAt < SESSION_EXPIRY_MS) {
          setSessionId(storedSessionId);

          const storedMessages = readStorage(
            `scalepods_messages_${storedSessionId}`,
          );
          if (storedMessages) {
            try {
              const restoredMessages = JSON.parse(storedMessages);
              if (Array.isArray(restoredMessages)) {
                setMessages(restoredMessages);

                // Don't re-announce agents already in restored history.
                for (const message of restoredMessages) {
                  if (!message || !message.agentName) continue;
                  if (message.role === "agent") {
                    announcedAgentsRef.current.add(message.agentName);
                  } else if (
                    message.role === "system" &&
                    !/disconnect/i.test(message.content || "")
                  ) {
                    announcedAgentsRef.current.add(message.agentName);
                  }
                }
              }
            } catch (error) {
              // Ignore corrupt history
            }
          }

          const storedLastId = readStorage(
            `scalepods_last_id_${storedSessionId}`,
          );
          if (storedLastId) {
            const parsedLastId = parseInt(storedLastId, 10);
            if (Number.isFinite(parsedLastId)) {
              lastMessageIdRef.current = parsedLastId;
            }
          }
          return;
        }
      }

      // Session expired or doesn't exist - create a new one.
      const newSessionId = createId();
      writeStorage("scalepods_session_id", newSessionId);
      writeStorage("scalepods_session_created_at", String(now));

      if (storedSessionId) {
        removeStorage(`scalepods_messages_${storedSessionId}`);
        removeStorage(`scalepods_last_id_${storedSessionId}`);
        removeStorage(`scalepods_last_created_at_${storedSessionId}`);
        removeStorage(`scalepods_last_bot_index_${storedSessionId}`);
      }

      setSessionId(newSessionId);
      setMessages([]);
      lastMessageIdRef.current = null;
      announcedAgentsRef.current.clear();
    }, []);

    useEffect(() => {
      initializeSession();

      // Check for agent mode via URL params
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get("role") === "agent") {
        setIsAgentMode(true);
      }
    }, [initializeSession]);

    useEffect(() => {
      if (sessionId && messages.length > 0) {
        writeStorage(
          `scalepods_messages_${sessionId}`,
          JSON.stringify(messages),
        );
      }
    }, [messages, sessionId]);

    useEffect(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    useEffect(() => {
      if (isOpen) {
        inputRef.current?.focus();
      }
    }, [isOpen]);

    const markActivity = useCallback(() => {
      lastActivityRef.current = Date.now();
    }, []);

    const pollForMessages = useCallback(async () => {
      if (!sessionId) return false;

      // No cursor yet means this is the first poll for the session (fresh load
      // or upgraded client). Used to avoid re-adding history from storage.
      const isFirstPoll = lastMessageIdRef.current === null;

      try {
        const params = new URLSearchParams({ session_id: sessionId });
        if (lastMessageIdRef.current !== null) {
          params.set("after_id", String(lastMessageIdRef.current));
        }

        const response = await fetch(`${MESSAGES_URL}?${params.toString()}`, {
          cache: "no-store",
        });

        if (!response.ok) return false;

        const data = await response.json();

        // Response format:
        // { count: N, messages: [{ id, session_id, role, content, created_at, Agent }] }
        const rows = Array.isArray(data?.messages)
          ? data.messages
          : Array.isArray(data)
            ? data
            : [];

        if (rows.length === 0) return true;

        // Advance the cursor using every returned row (including our own
        // messages). Rows inserted in the same transaction share the same
        // created_at, so the numeric id is the reliable cursor.
        const latestId = rows.reduce((latest, row) => {
          const rowId = Number(row.id);
          return Number.isFinite(rowId) && rowId > latest ? rowId : latest;
        }, lastMessageIdRef.current ?? 0);

        lastMessageIdRef.current = latestId;
        writeStorage(`scalepods_last_id_${sessionId}`, String(latestId));

        // Don't re-add the current sender's own messages — they're already in
        // local state. Roles are stored uppercase in the table (USER, BOT, AGENT).
        const ownRole = isAgentMode ? "agent" : "user";
        const newMessages = [];

        for (const row of rows) {
          if (!row || typeof row.content !== "string" || !row.content.trim()) {
            continue;
          }

          const content = row.content.trim();
          const createdAt = row.created_at || new Date().toISOString();
          const timestamp = row.created_at
            ? new Date(row.created_at).getTime()
            : Date.now();
          const id = row.id != null ? `db-${row.id}` : createdAt;
          const agentName = String(row.Agent ?? "").trim() || undefined;
          const rawRole = String(row.role ?? "").trim().toLowerCase();

          // Connection / disconnection notices. When the "Agent" column has a
          // name, show it: e.g. "John connected" instead of "Agent connected".
          // Only consider agent/system rows so user text can't trigger a notice.
          const notice = content.toLowerCase();
          const isNoticeRole =
            rawRole !== "user" && rawRole !== "bot" && rawRole !== "ai";
          const isDisconnectNotice =
            notice === "disconnect" ||
            notice === "disconnected" ||
            notice === "agent disconnected";
          const isConnectNotice =
            notice === "an agent just joined" ||
            notice === "agent joined" ||
            notice === "agent connected" ||
            notice === "connected to chat";

          if (isNoticeRole && (isConnectNotice || isDisconnectNotice)) {
            if (
              isConnectNotice &&
              agentName &&
              announcedAgentsRef.current.has(agentName)
            ) {
              continue;
            }

            const text = isDisconnectNotice
              ? agentName
                ? `${agentName} disconnected`
                : "Agent Disconnected"
              : agentName
                ? `${agentName} connected`
                : content;

            if (agentName) {
              if (isDisconnectNotice) {
                announcedAgentsRef.current.delete(agentName);
              } else {
                announcedAgentsRef.current.add(agentName);
              }
            }

            newMessages.push({
              id,
              content: text,
              role: "system",
              timestamp,
              created_at: createdAt,
              agentName,
            });
            continue;
          }

          const role =
            rawRole === "user"
              ? "user"
              : rawRole === "bot" ||
                  rawRole === "ai" ||
                  rawRole === "assistant"
                ? "ai"
                : rawRole === "agent"
                  ? "agent"
                  : rawRole === "system"
                    ? "system"
                    : null;

          // Skip internal rows ("To AI", "Summary") and the sender's own role
          if (role === null || role === ownRole) continue;

          // If an agent's first message arrives without a connection notice,
          // announce them once so the customer knows who they're chatting with.
          if (
            role === "agent" &&
            agentName &&
            !announcedAgentsRef.current.has(agentName)
          ) {
            announcedAgentsRef.current.add(agentName);
            newMessages.push({
              id: `${id}-connected`,
              content: `${agentName} connected`,
              role: "system",
              timestamp: timestamp - 1,
              agentName,
            });
          }

          newMessages.push({
            id,
            content,
            role,
            timestamp,
            created_at: createdAt,
            agentName,
          });
        }

        if (newMessages.length === 0) return true;

        // New incoming data keeps the conversation in fast-poll mode.
        lastActivityRef.current = Date.now();

        // Merge with existing messages, dedupe DB rows by id (and against
        // optimistic local messages by role + content), then sort by timestamp.
        setMessages((prev) => {
          const merged = [...prev];
          const newestLocalTimestamp = prev.reduce(
            (newest, message) => Math.max(newest, message.timestamp),
            0,
          );

          for (const message of newMessages) {
            // On the first poll after a reload, skip history that is already
            // present in local storage.
            if (
              isFirstPoll &&
              prev.length > 0 &&
              message.timestamp <= newestLocalTimestamp
            ) {
              continue;
            }

            // DB rows carry a unique id; optimistic local messages (added when
            // sending) don't have created_at, so match those by role + content.
            const isDuplicate = merged.some(
              (existing) =>
                String(existing.id) === String(message.id) ||
                (existing.created_at == null &&
                  existing.role === message.role &&
                  existing.content === message.content),
            );
            if (!isDuplicate) merged.push(message);
          }

          const unique = Array.from(
            new Map(merged.map((m) => [String(m.id), m])).values(),
          );
          return unique.sort((a, b) => a.timestamp - b.timestamp);
        });

        return true;
      } catch (error) {
        // Silently ignore polling errors; the scheduler will back off
        return false;
      }
    }, [sessionId, isAgentMode]);

    useEffect(() => {
      // Only poll while the widget is open and we have a session.
      if (!isOpen || !sessionId) return;

      // Opening the chat counts as activity, so start in fast-poll mode.
      lastActivityRef.current = Date.now();
      pollFailuresRef.current = 0;

      let cancelled = false;
      let running = false;
      let timeoutId = null;

      const getNextDelay = (ok) => {
        if (!ok) {
          pollFailuresRef.current += 1;
          return Math.min(
            POLLING_FAST_INTERVAL_MS * 2 ** pollFailuresRef.current,
            POLLING_MAX_BACKOFF_MS,
          );
        }

        pollFailuresRef.current = 0;
        const idleFor = Date.now() - lastActivityRef.current;
        return idleFor < POLLING_ACTIVE_WINDOW_MS
          ? POLLING_FAST_INTERVAL_MS
          : POLLING_IDLE_INTERVAL_MS;
      };

      const run = async () => {
        if (cancelled || running) return;

        // Don't poll in a background tab; visibilitychange resumes it.
        if (document.visibilityState === "hidden") return;

        running = true;
        let ok = false;
        try {
          ok = await pollForMessages();
        } finally {
          running = false;
        }

        if (cancelled) return;
        timeoutId = setTimeout(run, getNextDelay(ok));
      };

      run();

      const handleVisibilityChange = () => {
        if (document.visibilityState !== "visible") return;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        run();
      };

      document.addEventListener("visibilitychange", handleVisibilityChange);

      return () => {
        cancelled = true;
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };
    }, [isOpen, sessionId, pollForMessages]);

    const sendMessage = async () => {
      if (!inputValue.trim() || isLoading) return;

      markActivity();

      const userMessage = {
        id: createId(),
        content: inputValue.trim(),
        role: isAgentMode ? "agent" : "user",
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setInputValue("");
      setIsLoading(true);

      try {
        const response = await fetch(SEND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            message: userMessage.content,
            role: isAgentMode ? "agent" : "user",
          }),
        });

        if (!response.ok) throw new Error("Failed to send message");

        const responseText = await response.text();
        if (!responseText || responseText.trim() === "") return;

        let data;
        try {
          data = JSON.parse(responseText);
        } catch {
          return;
        }

        // Handle human takeover notification
        if (data.mode === "HUMAN") {
          const agentName = data.agent_name || "Support agent";
          // Remember the agent so polling doesn't announce them a second time
          announcedAgentsRef.current.add(agentName);
          setMessages((prev) => [
            ...prev,
            {
              id: createId(),
              content: `🔔 ${agentName} joined the conversation`,
              role: "system",
              timestamp: Date.now(),
              agentName,
            },
          ]);
        }

        const replyContent =
          data.reply ||
          data.message ||
          data.output ||
          data.response ||
          data.text;
        if (replyContent) {
          setMessages((prev) => [
            ...prev,
            {
              id: createId(),
              content: replyContent,
              role: "ai",
              timestamp: Date.now(),
            },
          ]);
        }
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            content: "Sorry, something went wrong. Please try again.",
            role: "system",
            timestamp: Date.now(),
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };

    const panelWidth = isExpanded ? 500 : 380;
    const panelHeight = isExpanded ? 600 : 520;

    return React.createElement(
      "div",
      {
        style: {
          position: "fixed",
          bottom: "20px",
          right: "20px",
          zIndex: 999999,
          pointerEvents: "none",
        },
      },
      !isOpen
        ? React.createElement(
            "button",
            {
              onClick: () => setIsOpen(true),
              "aria-label": t.openAriaLabel,
              className: "sp-btn-launcher",
              style: {
                width: "56px",
                height: "56px",
                borderRadius: "50%",
                background: "#000",
                color: "#fff",
                border: "2px solid #00CED1",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow:
                  "0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)",
                pointerEvents: "auto",
                transition: "transform 0.15s ease",
                animation: "scalepods-fadeIn 0.3s ease",
              },
              onMouseOver: (e) => {
                e.currentTarget.style.transform = "scale(1.05)";
              },
              onMouseOut: (e) => {
                e.currentTarget.style.transform = "scale(1)";
              },
            },
            MessageCircleIcon(24),
          )
        : React.createElement(
            "div",
            {
              style: {
                width: panelWidth + "px",
                height: panelHeight + "px",
                maxWidth: "calc(100vw - 40px)",
                maxHeight: "calc(100vh - 40px)",
                background: "#0a0a0a",
                borderRadius: "16px",
                boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                pointerEvents: "auto",
                border: "1px solid #262626",
                animation:
                  "scalepods-slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
                transformOrigin: "bottom right",
                transition: "width 0.3s ease, height 0.3s ease",
              },
            },
            // Header
            React.createElement(
              "div",
              {
                style: {
                  background: "#18181b",
                  padding: "10px 12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottom: "1px solid #262626",
                  flexShrink: 0,
                },
              },
              React.createElement(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "8px" } },
                React.createElement("img", {
                  src: LOGO_URL,
                  alt: "Scalepods",
                  style: {
                    width: "32px",
                    height: "32px",
                    objectFit: "contain",
                  },
                }),
                React.createElement(
                  "div",
                  null,
                  React.createElement(
                    "h2",
                    {
                      style: {
                        fontSize: "14px",
                        fontWeight: 600,
                        color: "#fafafa",
                        margin: 0,
                        lineHeight: 1.3,
                      },
                    },
                    "Scalepods AI",
                  ),
                  React.createElement(
                    "p",
                    {
                      style: {
                        fontSize: "10px",
                        color: "#a1a1a1",
                        margin: 0,
                        lineHeight: 1.3,
                      },
                    },
                    isAgentMode ? t.agentMode : t.online,
                  ),
                ),
              ),
              React.createElement(
                "div",
                { style: { display: "flex", gap: "4px" } },
                React.createElement(
                  "button",
                  {
                    onClick: () => setIsExpanded(!isExpanded),
                    "aria-label": isExpanded
                      ? t.minimizeAriaLabel
                      : t.expandAriaLabel,
                    className: "sp-btn-icon",
                    style: {
                      width: "32px",
                      height: "32px",
                      borderRadius: "50%",
                      background: "rgba(255,255,255,0.1)",
                      border: "none",
                      color: "#fafafa",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "background 0.15s ease",
                    },
                    onMouseOver: (e) => {
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.2)";
                    },
                    onMouseOut: (e) => {
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.1)";
                    },
                  },
                  isExpanded ? MinimizeIcon(16) : MaximizeIcon(16),
                ),
                React.createElement(
                  "button",
                  {
                    onClick: () => setIsOpen(false),
                    "aria-label": t.closeAriaLabel,
                    className: "sp-btn-icon",
                    style: {
                      width: "32px",
                      height: "32px",
                      borderRadius: "50%",
                      background: "rgba(255,255,255,0.1)",
                      border: "none",
                      color: "#fafafa",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "background 0.15s ease",
                    },
                    onMouseOver: (e) => {
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.2)";
                    },
                    onMouseOut: (e) => {
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.1)";
                    },
                  },
                  CloseIcon(16),
                ),
              ),
            ),
            // Messages area
            React.createElement(
              "div",
              {
                className: "scalepods-messages",
                style: {
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                  overscrollBehavior: "contain",
                  padding: "16px",
                  background: "#0a0a0a",
                },
              },
              messages.length === 0
                ? React.createElement(
                    "div",
                    {
                      style: {
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        height: "100%",
                        textAlign: "center",
                        color: "#a1a1a1",
                      },
                    },
                    React.createElement("img", {
                      src: LOGO_URL,
                      alt: "Scalepods",
                      style: {
                        width: "48px",
                        height: "48px",
                        marginBottom: "16px",
                        objectFit: "contain",
                        opacity: 0.5,
                      },
                    }),
                    React.createElement(
                      "p",
                      {
                        style: {
                          margin: 0,
                          fontSize: "14px",
                          lineHeight: 1.5,
                        },
                      },
                      t.welcome,
                      React.createElement("br"),
                      t.question,
                    ),
                  )
                : React.createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: "16px" } },
                    messages.map((msg) =>
                      React.createElement(
                        "div",
                        {
                          key: msg.id,
                          className: "scalepods-message-enter",
                          style: {
                            display: "flex",
                            flexDirection: "column",
                            alignItems:
                              msg.role === "user"
                                ? "flex-end"
                                : msg.role === "system"
                                  ? "center"
                                  : "flex-start",
                          },
                        },
                        msg.role === "system"
                          ? React.createElement(
                              "div",
                              {
                                style: {
                                  background: "#262626",
                                  color: "#a1a1a1",
                                  padding: "8px 12px",
                                  borderRadius: "8px",
                                  fontSize: "12px",
                                  textAlign: "center",
                                },
                              },
                              msg.content,
                            )
                          : React.createElement(
                              React.Fragment,
                              null,
                              (msg.role === "agent" || msg.role === "ai") &&
                                React.createElement(
                                  "span",
                                  {
                                    style: {
                                      fontSize: "10px",
                                      fontWeight: 500,
                                      letterSpacing: "0.025em",
                                      textTransform: "uppercase",
                                      color: "#a1a1a1",
                                      marginBottom: "4px",
                                    },
                                  },
                                  msg.role === "agent"
                                    ? msg.agentName || t.agentLabel
                                    : t.aiLabel,
                                ),
                              React.createElement(
                                "div",
                                {
                                  style: {
                                    maxWidth: "80%",
                                    padding: "10px 16px",
                                    borderRadius: "16px",
                                    fontSize: "14px",
                                    lineHeight: 1.5,
                                    whiteSpace: "pre-line",
                                    wordBreak: "break-word",
                                    background:
                                      msg.role === "user" ? "#fafafa" : "#262626",
                                    color:
                                      msg.role === "user" ? "#171717" : "#fafafa",
                                    borderBottomRightRadius:
                                      msg.role === "user" ? "6px" : "16px",
                                    borderBottomLeftRadius:
                                      msg.role === "user" ? "16px" : "6px",
                                  },
                                },
                                msg.content,
                              ),
                            ),
                      ),
                    ),
                    isLoading &&
                      React.createElement(
                        "div",
                        { style: { display: "flex", justifyContent: "flex-start" } },
                        React.createElement(
                          "div",
                          {
                            style: {
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              background: "#262626",
                              color: "#a1a1a1",
                              padding: "10px 16px",
                              borderRadius: "16px",
                              borderBottomLeftRadius: "6px",
                              fontSize: "14px",
                            },
                          },
                          React.createElement(
                            "span",
                            {
                              className: "scalepods-spinner",
                              style: {
                                display: "inline-flex",
                                width: "16px",
                                height: "16px",
                              },
                            },
                            icon(["M21 12a9 9 0 1 1-6.219-8.56"], 16),
                          ),
                          React.createElement("span", null, t.typing),
                        ),
                      ),
                    React.createElement("div", { ref: messagesEndRef }),
                  ),
            ),
            // Input area
            React.createElement(
              "div",
              {
                style: {
                  padding: "16px",
                  borderTop: "1px solid #262626",
                  background: "#0a0a0a",
                  flexShrink: 0,
                },
              },
              React.createElement(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "8px" } },
                React.createElement("input", {
                  ref: inputRef,
                  type: "text",
                  value: inputValue,
                  onChange: (e) => {
                    setInputValue(e.target.value);
                    markActivity();
                  },
                  onKeyDown: handleKeyDown,
                  placeholder: isAgentMode
                    ? t.agentPlaceholder
                    : t.userPlaceholder,
                  "aria-label": isAgentMode
                    ? t.agentPlaceholder
                    : t.userPlaceholder,
                  disabled: isLoading,
                  className: "sp-input",
                  style: {
                    flex: 1,
                    minWidth: 0,
                    padding: "10px 16px",
                    borderRadius: "9999px",
                    border: "1px solid #262626",
                    background: "#0a0a0a",
                    color: "#fafafa",
                    fontSize: "14px",
                    outline: "none",
                    opacity: isLoading ? 0.5 : 1,
                  },
                  onFocus: (e) => {
                    e.currentTarget.style.borderColor = "#525252";
                    e.currentTarget.style.boxShadow =
                      "0 0 0 2px rgba(82,82,82,0.5)";
                  },
                  onBlur: (e) => {
                    e.currentTarget.style.borderColor = "#262626";
                    e.currentTarget.style.boxShadow = "none";
                  },
                }),
                React.createElement(
                  "button",
                  {
                    onClick: sendMessage,
                    disabled: !inputValue.trim() || isLoading,
                    "aria-label": t.sendAriaLabel,
                    className: "sp-btn-send",
                    style: {
                      width: "40px",
                      height: "40px",
                      borderRadius: "50%",
                      border: "none",
                      background: "#fafafa",
                      color: "#171717",
                      cursor:
                        inputValue.trim() && !isLoading
                          ? "pointer"
                          : "not-allowed",
                      opacity: inputValue.trim() && !isLoading ? 1 : 0.5,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "background 0.15s ease, opacity 0.15s ease",
                    },
                    onMouseOver: (e) => {
                      if (inputValue.trim() && !isLoading) {
                        e.currentTarget.style.background = "#e5e5e5";
                      }
                    },
                    onMouseOut: (e) => {
                      e.currentTarget.style.background = "#fafafa";
                    },
                  },
                  SendIcon(16),
                ),
              ),
            ),
          ),
    );
  }

  // Initialize the widget. Create the mount node if the host page didn't.
  let rootElement = document.getElementById("scalepods-chat-root");
  if (!rootElement) {
    rootElement = document.createElement("div");
    rootElement.id = "scalepods-chat-root";
    document.body.appendChild(rootElement);
  }

  const root = ReactDOM.createRoot(rootElement);
  root.render(React.createElement(ChatWidget));
})();

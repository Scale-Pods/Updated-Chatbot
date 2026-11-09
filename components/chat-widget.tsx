"use client"

import type React from "react"

import { useState, useEffect, useRef, useCallback } from "react"
import { MessageCircle, X, Send, Loader2, Maximize2, Minimize2 } from "lucide-react"
import { cn } from "@/lib/utils"

// These point at this app's own API routes, which read the real n8n URLs from
// the server-side environment. No upstream URL or credential lives in the
// client bundle.
const WEBHOOK_URL = process.env.NEXT_PUBLIC_CHAT_SEND_API_URL || "/api/chat/send"
const MESSAGES_API_URL = process.env.NEXT_PUBLIC_CHAT_MESSAGES_API_URL || "/api/chat/messages"

const SESSION_EXPIRY_MS = 12 * 60 * 60 * 1000

// Polling is adaptive so an open chat feels responsive without hammering
// Supabase: fast while the conversation is active, slower when idle, with
// exponential backoff on errors and a full pause while the tab is hidden.
const POLLING_FAST_INTERVAL_MS = 3 * 1000
const POLLING_IDLE_INTERVAL_MS = 12 * 1000
const POLLING_ACTIVE_WINDOW_MS = 2 * 60 * 1000
const POLLING_MAX_BACKOFF_MS = 60 * 1000

interface Message {
  id: number | string
  content: string
  role: "user" | "agent" | "ai" | "system"
  timestamp: number
  created_at?: string
  /** Name of the human agent from the "Agent" column, when present. */
  agentName?: string
}

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
  },
}

// Detect language synchronously before component renders
function detectLanguage(): "en" | "ar" {
  if (typeof window === "undefined") return "en"
  const browserLang = navigator.language || "en"
  console.log("[v0] Browser language:", browserLang)
  const detected = browserLang.startsWith("ar") ? "ar" : "en"
  console.log("[v0] Detected language:", detected)
  return detected
}

export function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [inputValue, setInputValue] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string>("")
  const [isAgentMode, setIsAgentMode] = useState(false)
  const [lang, setLang] = useState<"en" | "ar">(() => detectLanguage())
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const lastMessageIdRef = useRef<number | null>(null)
  // Last time the user interacted or a new message arrived. Keeps polling fast
  // while the conversation is active, then lets it fall back to the idle rate.
  const lastActivityRef = useRef<number>(Date.now())
  // Consecutive failed polls, used for exponential backoff.
  const pollFailuresRef = useRef<number>(0)
  const lastBotIndexRef = useRef<number>(-1)
  // Names of agents we've already announced as connected in this session.
  const announcedAgentsRef = useRef<Set<string>>(new Set())

  const t = translations[lang]

  const initializeSession = useCallback(() => {
    const storedSessionId = localStorage.getItem("scalepods_session_id")
    const storedCreatedAt = localStorage.getItem("scalepods_session_created_at")
    const now = Date.now()

    // Check if session exists and is not expired
    if (storedSessionId && storedCreatedAt) {
      const createdAt = Number.parseInt(storedCreatedAt, 10)
      if (now - createdAt < SESSION_EXPIRY_MS) {
        // Session is valid
        setSessionId(storedSessionId)

        // Load chat history
        const storedMessages = localStorage.getItem(`scalepods_messages_${storedSessionId}`)
        if (storedMessages) {
          const restoredMessages: Message[] = JSON.parse(storedMessages)
          setMessages(restoredMessages)

          // Don't re-announce agents that are already in the restored history
          for (const message of restoredMessages) {
            if (!message.agentName) continue
            if (message.role === "agent") {
              announcedAgentsRef.current.add(message.agentName)
            } else if (
              message.role === "system" &&
              !/disconnect/i.test(message.content)
            ) {
              announcedAgentsRef.current.add(message.agentName)
            }
          }
        }

        // Load last message id (polling cursor)
        const storedLastId = localStorage.getItem(`scalepods_last_id_${storedSessionId}`)
        if (storedLastId) {
          lastMessageIdRef.current = Number.parseInt(storedLastId, 10)
        }

        // Load last bot index
        const storedLastBotIndex = localStorage.getItem(`scalepods_last_bot_index_${storedSessionId}`)
        if (storedLastBotIndex) {
          lastBotIndexRef.current = Number.parseInt(storedLastBotIndex, 10)
        }
        return
      }
    }

    // Session expired or doesn't exist - create new session
    const newSessionId = crypto.randomUUID()
    localStorage.setItem("scalepods_session_id", newSessionId)
    localStorage.setItem("scalepods_session_created_at", now.toString())

    // Clear old session data if exists
    if (storedSessionId) {
      localStorage.removeItem(`scalepods_messages_${storedSessionId}`)
      localStorage.removeItem(`scalepods_last_created_at_${storedSessionId}`)
      localStorage.removeItem(`scalepods_last_id_${storedSessionId}`)
      localStorage.removeItem(`scalepods_last_bot_index_${storedSessionId}`)
    }

    setSessionId(newSessionId)
    setMessages([])
    lastMessageIdRef.current = null
    lastBotIndexRef.current = -1
    announcedAgentsRef.current.clear()
  }, [])

  useEffect(() => {
    initializeSession()

    // Check for agent mode via URL params
    const urlParams = new URLSearchParams(window.location.search)
    if (urlParams.get("role") === "agent") {
      setIsAgentMode(true)
    }
  }, [initializeSession])

  useEffect(() => {
    if (sessionId && messages.length > 0) {
      localStorage.setItem(`scalepods_messages_${sessionId}`, JSON.stringify(messages))
    }
  }, [messages, sessionId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus()
    }
  }, [isOpen])

  const markActivity = useCallback(() => {
    lastActivityRef.current = Date.now()
  }, [])

  const pollForMessages = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false

    // No cursor yet means this is the first poll for the session (fresh load or
    // upgraded client). Used to avoid re-adding history restored from storage.
    const isFirstPoll = lastMessageIdRef.current === null

    try {
      const params = new URLSearchParams({ session_id: sessionId })
      if (lastMessageIdRef.current !== null) {
        params.set("after_id", String(lastMessageIdRef.current))
      }

      const response = await fetch(`${MESSAGES_API_URL}?${params.toString()}`, {
        cache: "no-store",
      })

      if (!response.ok) {
        return false
      }

      const data = await response.json()

      // Response format: { count: N, messages: [{ id, session_id, role, content, created_at, Agent }] }
      const rows: Array<{
        id: number | string
        session_id: string
        role: string | null
        content: string | null
        created_at: string | null
        Agent: string | null
      }> = Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data)
          ? data
          : []

      if (rows.length === 0) {
        return true
      }

      // Advance the cursor using every returned row (including our own messages).
      // Rows inserted in the same transaction share the same created_at, so the
      // numeric id is the reliable cursor.
      const latestId = rows.reduce((latest, row) => {
        const rowId = Number(row.id)
        return Number.isFinite(rowId) && rowId > latest ? rowId : latest
      }, lastMessageIdRef.current ?? 0)

      lastMessageIdRef.current = latestId
      localStorage.setItem(`scalepods_last_id_${sessionId}`, String(latestId))

      // Don't re-add the current sender's own messages — they're already in
      // local state. Roles are stored uppercase in the table (USER, BOT, AGENT).
      const ownRole = isAgentMode ? "agent" : "user"

      const newMessages: Message[] = []

      for (const row of rows) {
        if (!row.content || !row.content.trim()) continue

        const content = row.content.trim()
        const createdAt = row.created_at || new Date().toISOString()
        const timestamp = row.created_at ? new Date(row.created_at).getTime() : Date.now()
        const id = row.id != null ? `db-${row.id}` : createdAt
        // Name of the human agent from the "Agent" column, when present.
        const agentName = (row.Agent ?? "").trim() || undefined
        const rawRole = (row.role ?? "").trim().toLowerCase()

        // Connection / disconnection notices. When the "Agent" column has a
        // name, show it: e.g. "John connected" instead of "Agent connected".
        // Only consider agent/system rows so user text can't trigger a notice.
        const notice = content.toLowerCase()
        const isNoticeRole =
          rawRole !== "user" && rawRole !== "bot" && rawRole !== "ai"
        const isDisconnectNotice =
          notice === "disconnect" ||
          notice === "disconnected" ||
          notice === "agent disconnected"
        const isConnectNotice =
          notice === "an agent just joined" ||
          notice === "agent joined" ||
          notice === "agent connected" ||
          notice === "connected to chat"

        if (isNoticeRole && (isConnectNotice || isDisconnectNotice)) {
          // Already announced (e.g. via the send webhook or the first message)
          if (
            isConnectNotice &&
            agentName &&
            announcedAgentsRef.current.has(agentName)
          ) {
            continue
          }

          const text = isDisconnectNotice
            ? agentName
              ? `${agentName} disconnected`
              : "Agent Disconnected"
            : agentName
              ? `${agentName} connected`
              : content

          if (agentName) {
            if (isDisconnectNotice) {
              announcedAgentsRef.current.delete(agentName)
            } else {
              announcedAgentsRef.current.add(agentName)
            }
          }

          newMessages.push({
            id,
            content: text,
            role: "system",
            timestamp,
            created_at: createdAt,
            agentName,
          })
          continue
        }

        const role: Message["role"] | null =
          rawRole === "user"
            ? "user"
            : rawRole === "bot" || rawRole === "ai" || rawRole === "assistant"
              ? "ai"
              : rawRole === "agent"
                ? "agent"
                : rawRole === "system"
                  ? "system"
                  : null

        // Skip internal rows ("To AI", "Summary") and the sender's own role
        if (role === null || role === ownRole) {
          continue
        }

        // If an agent's first message arrives without a connection notice,
        // announce them once so the customer knows who they're chatting with.
        if (role === "agent" && agentName && !announcedAgentsRef.current.has(agentName)) {
          announcedAgentsRef.current.add(agentName)
          newMessages.push({
            id: `${id}-connected`,
            content: `${agentName} connected`,
            role: "system",
            timestamp: timestamp - 1,
            agentName,
          })
        }

        newMessages.push({ id, content, role, timestamp, created_at: createdAt, agentName })
      }

      if (newMessages.length === 0) {
        return true
      }

      // New incoming data keeps the conversation in fast-poll mode.
      lastActivityRef.current = Date.now()

      // Merge with existing messages, dedupe DB rows by id (and against
      // optimistic local messages by role + content), then sort by timestamp
      // for real-time feel.
      setMessages((prev) => {
        const merged = [...prev]
        const newestLocalTimestamp = prev.reduce(
          (newest, message) => Math.max(newest, message.timestamp),
          0,
        )

        for (const message of newMessages) {
          // On the first poll after a reload, skip history that is already
          // present in local storage.
          if (
            isFirstPoll &&
            prev.length > 0 &&
            message.timestamp <= newestLocalTimestamp
          ) {
            continue
          }

          // DB rows carry a unique id; optimistic local messages (added when
          // sending) don't have created_at, so match those by role + content.
          const isDuplicate = merged.some(
            (existing) =>
              String(existing.id) === String(message.id) ||
              (existing.created_at == null &&
                existing.role === message.role &&
                existing.content === message.content),
          )
          if (!isDuplicate) {
            merged.push(message)
          }
        }

        const unique = Array.from(new Map(merged.map((m) => [String(m.id), m])).values())
        return unique.sort((a, b) => a.timestamp - b.timestamp)
      })

      return true
    } catch (error) {
      // Silently ignore polling errors; the scheduler will back off
      return false
    }
  }, [sessionId, isAgentMode])

  useEffect(() => {
    // Only poll while the widget is open and we have a session.
    if (!isOpen || !sessionId) return

    // Opening the chat counts as activity, so start in fast-poll mode.
    lastActivityRef.current = Date.now()
    pollFailuresRef.current = 0

    let cancelled = false
    let running = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const getNextDelay = (ok: boolean) => {
      if (!ok) {
        pollFailuresRef.current += 1
        return Math.min(
          POLLING_FAST_INTERVAL_MS * 2 ** pollFailuresRef.current,
          POLLING_MAX_BACKOFF_MS,
        )
      }

      pollFailuresRef.current = 0
      const idleFor = Date.now() - lastActivityRef.current
      return idleFor < POLLING_ACTIVE_WINDOW_MS
        ? POLLING_FAST_INTERVAL_MS
        : POLLING_IDLE_INTERVAL_MS
    }

    const run = async () => {
      if (cancelled || running) return

      // Don't poll in a background tab; visibilitychange resumes it.
      if (document.visibilityState === "hidden") return

      running = true
      let ok = false
      try {
        ok = await pollForMessages()
      } finally {
        running = false
      }

      if (cancelled) return

      timeoutId = setTimeout(run, getNextDelay(ok))
    }

    // Poll immediately when the widget opens
    run()

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      run()
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }
  }, [isOpen, sessionId, pollForMessages])

  const sendMessage = async () => {
    if (!inputValue.trim() || isLoading) return

    markActivity()

    const userMessage: Message = {
      id: crypto.randomUUID(),
      content: inputValue.trim(),
      role: isAgentMode ? "agent" : "user",
      timestamp: Date.now(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInputValue("")
    setIsLoading(true)

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: sessionId,
          message: userMessage.content,
          role: isAgentMode ? "agent" : "user",
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to send message")
      }

      // Handle empty or non-JSON responses from send webhook
      const responseText = await response.text()
      if (!responseText || responseText.trim() === "") {
        // Empty response is OK, no reply from AI
        return
      }

      let data
      try {
        data = JSON.parse(responseText)
      } catch {
        // Not valid JSON, skip
        return
      }

      // Handle human takeover notification
      if (data.mode === "HUMAN") {
        const agentName = data.agent_name || "Support agent"
        // Remember the agent so polling doesn't announce them a second time
        announcedAgentsRef.current.add(agentName)
        const systemMessage: Message = {
          id: crypto.randomUUID(),
          content: `🔔 ${agentName} joined the conversation`,
          role: "system",
          timestamp: Date.now(),
          agentName,
        }
        setMessages((prev) => [...prev, systemMessage])
      }

      const replyContent = data.reply || data.message || data.output || data.response || data.text
      if (replyContent) {
        const aiMessage: Message = {
          id: crypto.randomUUID(),
          content: replyContent,
          role: "ai",
          timestamp: Date.now(),
        }
        setMessages((prev) => [...prev, aiMessage])
      }
    } catch (error) {
      console.error("[v0] Error sending message:", error)
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        content: "Sorry, something went wrong. Please try again.",
        role: "system",
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value)
    markActivity()
  }

  // When closed: only button (56x56), when open: full chat panel
  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-black text-white shadow-lg ring-2 ring-[#00CED1] transition-transform hover:scale-105"
        aria-label={t.openAriaLabel}
      >
        <MessageCircle className="h-6 w-6" />
      </button>
    )
  }

  // Open state: full chat panel
  const panelWidth = isExpanded ? 500 : 380
  const panelHeight = isExpanded ? 600 : 520

  return (
    <div
      style={{ width: panelWidth, height: panelHeight }}
      className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-zinc-900 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <img src="/images/scalepods-logo.png" alt="Scalepods Logo" className="h-8 w-8 object-contain" />
          <div>
            <h2 className="text-sm font-semibold text-white">Scalepods AI</h2>
            <p className="text-[10px] text-zinc-400">{isAgentMode ? t.agentMode : t.online}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            aria-label={isExpanded ? t.minimizeAriaLabel : t.expandAriaLabel}
          >
            {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            aria-label={t.closeAriaLabel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <img src="/images/scalepods-logo.png" alt="Scalepods Logo" className="mb-4 h-12 w-12 opacity-50" />
            <p className="text-sm text-muted-foreground">
              {t.welcome}
              <br />
              {t.question}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "flex flex-col",
                  message.role === "user" && "items-end",
                  (message.role === "agent" || message.role === "ai") && "items-start",
                  message.role === "system" && "items-center",
                )}
              >
                {message.role === "system" ? (
                  <div className="rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
                    {message.content}
                  </div>
                ) : (
                  <>
                    {message.role === "agent" && (
                      <span className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {message.agentName || t.agentLabel}
                      </span>
                    )}
                    {message.role === "ai" && (
                      <span className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t.aiLabel}
                      </span>
                    )}
                    <div
                      className={cn(
                        "max-w-[80%] whitespace-pre-line rounded-2xl px-4 py-2.5 text-sm",
                        message.role === "user"
                          ? "rounded-br-md bg-primary text-primary-foreground"
                          : "rounded-bl-md bg-muted text-foreground",
                      )}
                    >
                      {message.content}
                    </div>
                  </>
                )}
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t.typing}</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border p-4">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={isAgentMode ? t.agentPlaceholder : t.userPlaceholder}
            disabled={isLoading}
            className="flex-1 rounded-full border border-input bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={!inputValue.trim() || isLoading}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

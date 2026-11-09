(function() {
  // Prevent multiple initializations
  if (window.__SCALEPODS_CHAT_LOADED__) return;
  window.__SCALEPODS_CHAT_LOADED__ = true;

  // Inject CSS animations
  if (!document.getElementById('scalepods-animations')) {
    const style = document.createElement('style');
    style.id = 'scalepods-animations';
    style.textContent = `
      @keyframes scalepods-fadeIn {
        from {
          opacity: 0;
          transform: scale(0.8);
        }
        to {
          opacity: 1;
          transform: scale(1);
        }
      }
      
      @keyframes scalepods-slideIn {
        from {
          opacity: 0;
          transform: scale(0.9) translateY(10px);
        }
        to {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
      }
      
      @keyframes scalepods-messageSlide {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      
      @keyframes scalepods-pulse {
        0%, 100% {
          opacity: 0.6;
        }
        50% {
          opacity: 1;
        }
      }
      
      .scalepods-message-enter {
        animation: scalepods-messageSlide 0.3s ease;
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

  const { useState, useEffect, useRef, useCallback } = React;

  // Resolve this app's origin from the embed script itself so the widget works
  // on third-party sites. The real n8n URLs stay on the server, behind these
  // proxy routes, and are never shipped in this file.
  const API_BASE_URL = (() => {
    const script = document.currentScript || document.querySelector('script[src*="embed.js"]');
    if (script && script.src) {
      try {
        return new URL(script.src).origin;
      } catch (error) {
        // Fall through to the page origin below.
      }
    }
    return window.location.origin;
  })();

  const WEBHOOK_URL = `${API_BASE_URL}/api/chat/send`;
  const POLLING_WEBHOOK_URL = `${API_BASE_URL}/api/chat/poll`;
  const LOGO_URL = `${API_BASE_URL}/images/scalepods-logo.png`;
  const SESSION_EXPIRY_MS = 12 * 60 * 60 * 1000;
  const POLLING_INTERVAL_MS = 10 * 1000;

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
  };

  function detectLanguage() {
    const browserLang = navigator.language || "en";
    console.log("[v0] Browser language:", browserLang);
    const detected = browserLang.startsWith("ar") ? "ar" : "en";
    console.log("[v0] Detected language:", detected);
    return detected;
  }

  function ChatWidget() {
    const [isOpen, setIsOpen] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [sessionId, setSessionId] = useState("");
    const [isAgentMode, setIsAgentMode] = useState(false);
    const [lang, setLang] = useState(() => detectLanguage());
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const pollingIntervalRef = useRef(null);
    const lastCreatedAtRef = useRef(null);

    const t = translations[lang];

    const initializeSession = useCallback(() => {
      const storedSessionId = localStorage.getItem("scalepods_session_id");
      const storedCreatedAt = localStorage.getItem("scalepods_session_created_at");
      const now = Date.now();

      if (storedSessionId && storedCreatedAt) {
        const createdAt = parseInt(storedCreatedAt, 10);
        if (now - createdAt < SESSION_EXPIRY_MS) {
          setSessionId(storedSessionId);
          const storedMessages = localStorage.getItem(`scalepods_messages_${storedSessionId}`);
          if (storedMessages) {
            setMessages(JSON.parse(storedMessages));
          }
          const storedLastCreatedAt = localStorage.getItem(`scalepods_last_created_at_${storedSessionId}`);
          if (storedLastCreatedAt) {
            lastCreatedAtRef.current = storedLastCreatedAt;
          }
          return;
        }
      }

      const newSessionId = crypto.randomUUID();
      localStorage.setItem("scalepods_session_id", newSessionId);
      localStorage.setItem("scalepods_session_created_at", now.toString());
      if (storedSessionId) {
        localStorage.removeItem(`scalepods_messages_${storedSessionId}`);
        localStorage.removeItem(`scalepods_last_created_at_${storedSessionId}`);
      }
      setSessionId(newSessionId);
      setMessages([]);
      lastCreatedAtRef.current = null;
    }, []);

    useEffect(() => {
      initializeSession();
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get("role") === "agent") {
        setIsAgentMode(true);
      }
    }, [initializeSession]);

    useEffect(() => {
      if (sessionId && messages.length > 0) {
        localStorage.setItem(`scalepods_messages_${sessionId}`, JSON.stringify(messages));
      }
    }, [messages, sessionId]);

    useEffect(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    useEffect(() => {
      if (isOpen && inputRef.current) {
        inputRef.current.focus();
      }
    }, [isOpen]);

    const pollForMessages = useCallback(async () => {
      if (!sessionId) return;

      try {
        const response = await fetch(POLLING_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            after: lastCreatedAtRef.current || null,
          }),
        });

        if (!response.ok) return;

        const text = await response.text();
        if (!text || text.trim() === "") return;

        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return;
        }

        const messagesArray = data.messages || (Array.isArray(data) ? data : []);
        const agentMessages = messagesArray;

        if (agentMessages.length > 0) {
          const latestCreatedAt = agentMessages.reduce((latest, msg) => {
            return msg.created_at && msg.created_at > latest ? msg.created_at : latest;
          }, lastCreatedAtRef.current || "");

          if (latestCreatedAt) {
            lastCreatedAtRef.current = latestCreatedAt;
            localStorage.setItem(`scalepods_last_created_at_${sessionId}`, latestCreatedAt);
          }

          const newAgentMessages = agentMessages
            .filter((msg) => msg.message)
            .map((msg) => {
              const messageContent = msg.message.trim();
              if (messageContent === "An Agent Just Joined" || messageContent === "Disconnect") {
                const displayContent = messageContent === "Disconnect" ? "Agent Disconnected" : messageContent;
                return {
                  id: msg.created_at || crypto.randomUUID(),
                  content: displayContent,
                  role: "system",
                  timestamp: msg.created_at ? new Date(msg.created_at).getTime() : Date.now(),
                  created_at: msg.created_at || new Date().toISOString(),
                };
              }
              return {
                id: msg.created_at || crypto.randomUUID(),
                content: messageContent,
                role: "agent",
                timestamp: msg.created_at ? new Date(msg.created_at).getTime() : Date.now(),
                created_at: msg.created_at || new Date().toISOString(),
              };
            });

          setMessages((prev) => {
            const merged = [...prev, ...newAgentMessages];
            const unique = Array.from(new Map(merged.map((m) => [String(m.id), m])).values());
            return unique.sort((a, b) => a.timestamp - b.timestamp);
          });
        }
      } catch (error) {
        // Silently ignore polling errors
      }
    }, [sessionId]);

    useEffect(() => {
      if (!isOpen) {
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
        return;
      }

      pollForMessages();
      pollingIntervalRef.current = setInterval(() => {
        pollForMessages();
      }, POLLING_INTERVAL_MS);

      return () => {
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
        }
      };
    }, [isOpen, pollForMessages]);

    const sendMessage = async () => {
      if (!inputValue.trim() || isLoading) return;

      const userMessage = {
        id: crypto.randomUUID(),
        content: inputValue.trim(),
        role: isAgentMode ? "agent" : "user",
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setInputValue("");
      setIsLoading(true);

      try {
        const response = await fetch(WEBHOOK_URL, {
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

        if (data.mode === "HUMAN") {
          const agentName = data.agent_name || "Support agent";
          const systemMessage = {
            id: crypto.randomUUID(),
            content: `🔔 ${agentName} joined the conversation`,
            role: "system",
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, systemMessage]);
        }

        const replyContent = data.reply || data.message || data.output || data.response || data.text;
        if (replyContent) {
          const aiMessage = {
            id: crypto.randomUUID(),
            content: replyContent,
            role: "ai",
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, aiMessage]);
        }
      } catch (error) {
        const errorMessage = {
          id: crypto.randomUUID(),
          content: "Sorry, something went wrong. Please try again.",
          role: "system",
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMessage]);
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
      'div',
      {
        style: {
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          zIndex: 999999,
          pointerEvents: 'none'
        }
      },
      !isOpen
        ? React.createElement(
            'button',
            {
              onClick: () => setIsOpen(true),
              'aria-label': t.openAriaLabel,
              style: {
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                background: '#000',
                color: '#fff',
                border: '2px solid #00CED1',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                pointerEvents: 'auto',
                transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                animation: 'scalepods-fadeIn 0.3s ease'
              },
              onMouseOver: (e) => {
                e.currentTarget.style.transform = 'scale(1.1)';
                e.currentTarget.style.boxShadow = '0 6px 16px rgba(0,206,209,0.4)';
              },
              onMouseOut: (e) => {
                e.currentTarget.style.transform = 'scale(1)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
              }
            },
            React.createElement('svg', {
              width: 24,
              height: 24,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              viewBox: '0 0 24 24'
            }, 
              React.createElement('path', {
                d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'
              })
            )
          )
        : React.createElement(
            'div',
            {
              style: {
                width: panelWidth + 'px',
                height: panelHeight + 'px',
                background: '#000',
                borderRadius: '20px',
                boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                pointerEvents: 'auto',
                border: '1px solid #27272a',
                animation: 'scalepods-slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
                transformOrigin: 'bottom right',
                transition: 'width 0.3s ease, height 0.3s ease'
              }
            },
            // Header
            React.createElement(
              'div',
              {
                style: {
                  background: '#0a0a0a',
                  padding: '14px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid #1a1a1a'
                }
              },
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                React.createElement('img', {
                  src: LOGO_URL,
                  alt: 'Scalepods',
                  style: {
                    width: '36px',
                    height: '36px',
                    borderRadius: '8px',
                    objectFit: 'contain'
                  }
                }),
                React.createElement(
                  'div',
                  null,
                  React.createElement('h2', {
                    style: {
                      fontSize: '14px',
                      fontWeight: '600',
                      color: '#fff',
                      margin: 0
                    }
                  }, 'Scalepods AI'),
                  React.createElement('p', {
                    style: {
                      fontSize: '10px',
                      color: '#a1a1aa',
                      margin: 0
                    }
                  }, isAgentMode ? t.agentMode : t.online)
                )
              ),
              React.createElement(
                'div',
                { style: { display: 'flex', gap: '4px' } },
                React.createElement(
                  'button',
                  {
                    onClick: () => setIsExpanded(!isExpanded),
                    'aria-label': isExpanded ? t.minimizeAriaLabel : t.expandAriaLabel,
                    style: {
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      background: 'rgba(255,255,255,0.1)',
                      border: 'none',
                      color: '#fff',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'all 0.2s ease'
                    },
                    onMouseOver: (e) => e.currentTarget.style.background = 'rgba(255,255,255,0.2)',
                    onMouseOut: (e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                  },
                  React.createElement('svg', {
                    width: 16,
                    height: 16,
                    fill: 'currentColor',
                    viewBox: '0 0 24 24'
                  }, React.createElement('path', {
                    d: isExpanded ? 'M4 11h16v2H4z' : 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z'
                  }))
                ),
                React.createElement(
                  'button',
                  {
                    onClick: () => setIsOpen(false),
                    'aria-label': t.closeAriaLabel,
                    style: {
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      background: 'rgba(255,255,255,0.1)',
                      border: 'none',
                      color: '#fff',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'all 0.2s ease'
                    },
                    onMouseOver: (e) => e.currentTarget.style.background = 'rgba(255,255,255,0.2)',
                    onMouseOut: (e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                  },
                  React.createElement('svg', {
                    width: 16,
                    height: 16,
                    fill: 'currentColor',
                    viewBox: '0 0 24 24'
                  }, React.createElement('path', {
                    d: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'
                  }))
                )
              )
            ),
            // Messages area
            React.createElement(
              'div',
              {
                className: 'scalepods-messages',
                style: {
                  flex: 1,
                  overflowY: 'auto',
                  padding: '16px',
                  background: '#000'
                }
              },
              messages.length === 0
                ? React.createElement(
                    'div',
                    {
                      style: {
                        textAlign: 'center',
                        color: '#a1a1aa',
                        paddingTop: '60px'
                      }
                    },
                    React.createElement('img', {
                      src: LOGO_URL,
                      alt: 'Scalepods',
                      style: {
                        width: '64px',
                        height: '64px',
                        margin: '0 auto 16px',
                        borderRadius: '12px',
                        objectFit: 'contain'
                      }
                    }),
                    React.createElement('p', { style: { margin: '0 0 8px', fontSize: '15px', color: '#e5e5e5' } }, t.welcome),
                    React.createElement('p', { style: { fontSize: '14px', margin: 0, color: '#71717a' } }, t.question)
                  )
                : React.createElement(
                    'div',
                    null,
                    messages.map((msg) =>
                      React.createElement(
                        'div',
                        {
                          key: msg.id,
                          className: 'scalepods-message-enter',
                          style: {
                            marginBottom: '16px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: msg.role === 'user' ? 'flex-end' : msg.role === 'system' ? 'center' : 'flex-start'
                          }
                        },
                        msg.role === 'system'
                          ? React.createElement(
                              'div',
                              {
                                style: {
                                  background: '#1a1a1a',
                                  padding: '8px 12px',
                                  borderRadius: '8px',
                                  fontSize: '12px',
                                  color: '#a1a1aa'
                                }
                              },
                              msg.content
                            )
                          : React.createElement(
                              React.Fragment,
                              null,
                              (msg.role === 'agent' || msg.role === 'ai') &&
                                React.createElement(
                                  'span',
                                  {
                                    style: {
                                      fontSize: '10px',
                                      color: '#71717a',
                                      marginBottom: '4px',
                                      textTransform: 'uppercase',
                                      fontWeight: '500'
                                    }
                                  },
                                  msg.role === 'agent' ? t.agentLabel : t.aiLabel
                                ),
                              React.createElement(
                                'div',
                                {
                                  style: {
                                    maxWidth: '80%',
                                    padding: '10px 16px',
                                    borderRadius: '16px',
                                    fontSize: '14px',
                                    background: msg.role === 'user' ? '#4c4c4c' : '#1a1a1a',
                                    color: msg.role === 'user' ? '#fff' : '#e5e5e5',
                                    borderBottomRightRadius: msg.role === 'user' ? '4px' : '16px',
                                    borderBottomLeftRadius: msg.role === 'user' ? '16px' : '4px',
                                    border: msg.role !== 'user' ? '1px solid #2a2a2a' : 'none',
                                    whiteSpace: 'pre-line'
                                  }
                                },
                                msg.content
                              )
                            )
                      )
                    ),
                    isLoading &&
                      React.createElement(
                        'div',
                        { style: { display: 'flex', justifyContent: 'flex-start' } },
                        React.createElement(
                          'div',
                          {
                            style: {
                              background: '#1a1a1a',
                              padding: '10px 16px',
                              borderRadius: '16px',
                              fontSize: '14px',
                              color: '#a1a1aa',
                              border: '1px solid #2a2a2a',
                              animation: 'scalepods-pulse 1.5s ease-in-out infinite'
                            }
                          },
                          t.typing
                        )
                      ),
                    React.createElement('div', { ref: messagesEndRef })
                  )
            ),
            // Input area
            React.createElement(
              'div',
              {
                style: {
                  padding: '16px',
                  borderTop: '1px solid #1a1a1a',
                  background: '#000'
                }
              },
              React.createElement(
                'div',
                { style: { display: 'flex', gap: '8px' } },
                React.createElement('input', {
                  ref: inputRef,
                  type: 'text',
                  value: inputValue,
                  onChange: (e) => setInputValue(e.target.value),
                  onKeyDown: handleKeyDown,
                  placeholder: isAgentMode ? t.agentPlaceholder : t.userPlaceholder,
                  disabled: isLoading,
                  style: {
                    flex: 1,
                    padding: '12px 18px',
                    borderRadius: '24px',
                    border: '1px solid #2a2a2a',
                    fontSize: '14px',
                    outline: 'none',
                    background: '#0a0a0a',
                    color: '#e5e5e5'
                  }
                }),
                React.createElement(
                  'button',
                  {
                    onClick: sendMessage,
                    disabled: !inputValue.trim() || isLoading,
                    style: {
                      width: '44px',
                      height: '44px',
                      borderRadius: '50%',
                      background: inputValue.trim() && !isLoading ? '#4c4c4c' : '#1a1a1a',
                      border: 'none',
                      color: '#fff',
                      cursor: inputValue.trim() && !isLoading ? 'pointer' : 'not-allowed',
                      opacity: inputValue.trim() && !isLoading ? 1 : 0.5,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'all 0.2s ease'
                    },
                    onMouseOver: (e) => {
                      if (inputValue.trim() && !isLoading) {
                        e.currentTarget.style.transform = 'scale(1.05)';
                        e.currentTarget.style.background = '#5c5c5c';
                      }
                    },
                    onMouseOut: (e) => {
                      if (inputValue.trim() && !isLoading) {
                        e.currentTarget.style.transform = 'scale(1)';
                        e.currentTarget.style.background = '#4c4c4c';
                      }
                    }
                  },
                  React.createElement('svg', {
                    width: 16,
                    height: 16,
                    fill: 'currentColor',
                    viewBox: '0 0 24 24'
                  }, React.createElement('path', {
                    d: 'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z'
                  }))
                )
              )
            )
          )
    );
  }

  // Initialize the widget
  const root = ReactDOM.createRoot(document.getElementById('scalepods-chat-root'));
  root.render(React.createElement(ChatWidget));
})();

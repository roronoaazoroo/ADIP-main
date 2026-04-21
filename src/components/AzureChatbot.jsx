import React, { useState, useRef, useEffect } from 'react'
import './AzureChatbot.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

async function sendMessage(messages, context) {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, context }),
  })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()).reply
}

export default function AzureChatbot({ context }) {
  const [open,     setOpen]     = useState(false)
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Welcome. I am available to support your Azure cloud initiatives, providing detailed guidance on Azure services.' }
  ])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const bottomRef  = useRef(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  const send = async () => {
    const text = input.trim()
    if (!text || loading) return
    const userMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)
    try {
      const reply = await sendMessage([...messages, userMsg].filter(m => m.role !== 'assistant' || messages.indexOf(m) > 0), context)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="chatbot-container">
      {/* Chat window */}
      {open && (
        <div className="chatbot-window">
          {/* Header */}
          <div className="chatbot-header">
            <div className="chatbot-header-left">
              <div className="chatbot-status-dot" />
              <span className="chatbot-title">Azure Cloud Expert</span>
            </div>
            <button className="chatbot-close-btn" onClick={() => setOpen(false)}>✕</button>
          </div>

          {/* Messages */}
          <div className="chatbot-messages">
            {messages.map((m, i) => (
              <div key={i} className={`chatbot-msg-row chatbot-msg-row--${m.role}`}>
                <div className={`chatbot-msg-bubble chatbot-msg-bubble--${m.role}`}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="chatbot-typing">
                <div className="chatbot-typing-bubble">
                  {[0,1,2].map(i => <span key={i} className="chatbot-typing-dot" />)}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="chatbot-input-area">
            <input
              className="chatbot-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
              placeholder="Ask about Azure, drift, costs..."
              disabled={loading}
            />
            <button
              className="chatbot-send-btn"
              onClick={send}
              disabled={loading || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Toggle button */}
      <button
        className={`chatbot-fab ${open ? 'chatbot-fab--open' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Azure Cloud Expert"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
    </div>
  )
}

// FILE: src/components/AzureChatbot.jsx
// ROLE: Floating AI chatbot powered by Azure OpenAI (GPT-4o)

// Props:
//   context — optional { resourceId, driftSummary } injected into the system prompt
//             so the AI can answer questions about the currently viewed resource

// State:
//   open     — whether the chat window is visible (toggled by the FAB button)
//   messages — array of { role: 'user'|'assistant', content: string }
//              the full conversation history sent to the API on each turn
//   input    — the text currently typed in the input box
//   loading  — true while waiting for the AI response (shows typing indicator)

// sendMessage(messages, context):
//   POSTs to POST /api/chat with the last 20 turns of conversation history
//   The Express chat.js route calls Azure OpenAI with a system prompt that
//   positions the AI as an Azure cloud expert, optionally injecting resource context

// send():
//   Appends the user message, clears the input, calls sendMessage(),
//   appends the AI reply. On error, appends an error message instead.

// bottomRef: ref to an empty div at the bottom of the message list
//   scrollIntoView() is called on every new message to keep the latest visible

import React, { useState, useRef, useEffect, useCallback } from 'react'
import './AzureChatbot.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

const SUGGESTED_PROMPTS = [
  'What is configuration drift?',
  'How to prevent drift in Azure?',
  'Explain ARM template best practices',
]

// Sends the conversation history to POST /api/chat and returns the AI reply string
// context is optional — if provided, it's injected into the system prompt
async function sendMessage(conversationHistory, resourceContext) {
  const httpResponse = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: conversationHistory, context: resourceContext }),
  })
  if (!httpResponse.ok) throw new Error(await httpResponse.text())
  return (await httpResponse.json()).reply
}

export default function AzureChatbot({ context }) {
  const [open,     setOpen]     = useState(false)
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Welcome! I\u2019m your Azure Cloud Expert. Ask me about configuration drift, Azure services, or best practices.', timestamp: new Date() }
  ])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const bottomRef  = useRef(null)
  const inputRef   = useRef(null)

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      // Focus the input when chat opens
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [messages, open])

  // Keyboard shortcut: Ctrl+K or Cmd+K to toggle chat
  useEffect(() => {
    const handleKeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(prev => !prev)
      }
      // Escape to close
      if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeydown)
    return () => document.removeEventListener('keydown', handleKeydown)
  }, [open])

  const send = useCallback(async (text) => {
    const trimmedInput = (text || input).trim()
    if (!trimmedInput || loading) return

    // Build the new user message and append it to the conversation
    const newUserMessage = { role: 'user', content: trimmedInput, timestamp: new Date() }
    setMessages(previousMessages => [...previousMessages, newUserMessage])
    setInput('')
    setLoading(true)
    try {
      // Send the full conversation history (excluding the initial assistant greeting)
      const conversationHistory = [...messages, newUserMessage].filter(
        msg => msg.role !== 'assistant' || messages.indexOf(msg) > 0
      )
      const aiReply = await sendMessage(conversationHistory, context)
      setMessages(previousMessages => [...previousMessages, { role: 'assistant', content: aiReply, timestamp: new Date() }])
    } catch (sendError) {
      setMessages(previousMessages => [...previousMessages, { role: 'assistant', content: `Sorry, I encountered an error: ${sendError.message}. Please try again.`, timestamp: new Date(), isError: true }])
    } finally {
      setLoading(false)
    }
  }, [input, loading, messages, context])

  const formatTime = (date) => {
    if (!date) return ''
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="chatbot-container" role="complementary" aria-label="AI Chat Assistant">
      {/* Chat window */}
      {open && (
        <div className="chatbot-window" role="dialog" aria-label="Azure Cloud Expert Chat" aria-modal="false">
          {/* Header */}
          <div className="chatbot-header">
            <div className="chatbot-header-left">
              <div className="chatbot-status-dot" aria-hidden="true" />
              <div>
                <span className="chatbot-title">Azure Cloud Expert</span>
                <span className="chatbot-subtitle">AI-powered assistant</span>
              </div>
            </div>
            <button
              className="chatbot-close-btn"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="chatbot-messages" role="log" aria-live="polite" aria-label="Chat messages">
            {messages.map((chatMessage, messageIndex) => (
              <div key={messageIndex} className={`chatbot-msg-row chatbot-msg-row--${chatMessage.role}`}>
                <div className={`chatbot-msg-bubble chatbot-msg-bubble--${chatMessage.role} ${chatMessage.isError ? 'chatbot-msg-bubble--error' : ''}`}>
                  {chatMessage.content}
                </div>
                <span className="chatbot-msg-time">{formatTime(chatMessage.timestamp)}</span>
              </div>
            ))}
            {loading && (
              <div className="chatbot-typing" aria-label="AI is thinking...">
                <div className="chatbot-typing-bubble">
                  {[0,1,2].map(i => <span key={i} className="chatbot-typing-dot" />)}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Suggested prompts (shown when no user messages yet) */}
          {messages.length <= 1 && !loading && (
            <div className="chatbot-suggestions">
              {SUGGESTED_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  className="chatbot-suggestion-btn"
                  onClick={() => send(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="chatbot-input-area">
            <input
              ref={inputRef}
              className="chatbot-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
              placeholder="Ask about Azure, drift, costs..."
              disabled={loading}
              aria-label="Type your message"
            />
            <button
              className="chatbot-send-btn"
              onClick={() => send()}
              disabled={loading || !input.trim()}
              aria-label="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Toggle button */}
      <button
        className={`chatbot-fab ${open ? 'chatbot-fab--open' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'Close chat' : 'Open Azure Cloud Expert chat (Ctrl+K)'}
        aria-expanded={open}
      >
        {open ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        )}
      </button>
    </div>
  )
}

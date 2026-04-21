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

import React, { useState, useRef, useEffect } from 'react'
import './AzureChatbot.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

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
    { role: 'assistant', content: 'Welcome. I am available to support your Azure cloud initiatives, providing detailed guidance on Azure services.' }
  ])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const bottomRef  = useRef(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  const send = async () => {
    const trimmedInput = input.trim()
    if (!trimmedInput || loading) return

    // Build the new user message and append it to the conversation
    const newUserMessage = { role: 'user', content: trimmedInput }
    setMessages(previousMessages => [...previousMessages, newUserMessage])
    setInput('')
    setLoading(true)
    try {
      // Send the full conversation history (excluding the initial assistant greeting)
      const conversationHistory = [...messages, newUserMessage].filter(
        msg => msg.role !== 'assistant' || messages.indexOf(msg) > 0
      )
      const aiReply = await sendMessage(conversationHistory, context)
      setMessages(previousMessages => [...previousMessages, { role: 'assistant', content: aiReply }])
    } catch (sendError) {
      setMessages(previousMessages => [...previousMessages, { role: 'assistant', content: `Error: ${sendError.message}` }])
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
            {messages.map((chatMessage, messageIndex) => (
              <div key={messageIndex} className={`chatbot-msg-row chatbot-msg-row--${chatMessage.role}`}>
                <div className={`chatbot-msg-bubble chatbot-msg-bubble--${chatMessage.role}`}>
                  {chatMessage.content}
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

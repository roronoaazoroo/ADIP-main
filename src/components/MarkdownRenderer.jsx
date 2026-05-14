// FILE: src/components/MarkdownRenderer.jsx
// ROLE: Renders AI markdown responses with proper formatting
import React from 'react'
import ReactMarkdown from 'react-markdown'

const styles = {
  wrapper: { fontSize: 13, lineHeight: 1.6, color: 'inherit' },
  code: { background: 'rgba(0,0,0,0.15)', padding: '1px 5px', borderRadius: 4, fontSize: 12, fontFamily: 'var(--font-mono, monospace)' },
  pre: { background: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: '10px 12px', overflow: 'auto', fontSize: 12, margin: '8px 0' },
  li: { marginBottom: 4 },
}

export default function MarkdownRenderer({ content }) {
  if (!content) return null
  return (
    <div style={styles.wrapper}>
      <ReactMarkdown
        components={{
          code({ inline, children }) {
            return inline
              ? <code style={styles.code}>{children}</code>
              : <pre style={styles.pre}><code>{children}</code></pre>
          },
          p({ children }) { return <div style={{ marginBottom: 8 }}>{children}</div> },
          li({ children }) { return <li style={styles.li}>{children}</li> },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

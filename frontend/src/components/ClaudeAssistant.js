import React, { useState, useRef, useEffect } from 'react';

const QUICK_ACTIONS = [
  { id: 'find_online', label: '🔍 Find Online', desc: 'Search for this model on Printables, MMF, Thingiverse…' },
  { id: 'suggest_tags', label: '🏷 Suggest Tags', desc: 'Get tag ideas based on model name & creator' },
  { id: 'suggest_organization', label: '📋 Organize', desc: 'Full organization recommendations' },
  { id: 'suggest_notes', label: '🖨 Print Notes', desc: 'Printing tips, scale, supports, resin' },
];

function Message({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12
    }}>
      <div style={{
        maxWidth: '88%', padding: '8px 12px', borderRadius: isUser ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
        background: isUser ? 'rgba(193,127,58,0.15)' : 'var(--bg3)',
        border: `1px solid ${isUser ? 'rgba(193,127,58,0.3)' : 'var(--border)'}`,
        fontSize: 12, color: 'var(--text)', lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word'
      }}>
        {msg.content}
      </div>

      {/* Search Results */}
      {msg.searchResults && msg.searchResults.length > 0 && (
        <div style={{ maxWidth: '88%', marginTop: 8, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 8 }}>
            Found Online
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {msg.searchResults.map((r, i) => (
              <a key={i} href={r.url} target="_blank" rel="noopener noreferrer"
                style={{
                  display: 'block', padding: '8px 10px', background: 'var(--bg4)',
                  border: '1px solid var(--border)', borderRadius: 5,
                  textDecoration: 'none', color: 'var(--text)',
                  transition: 'border-color 0.12s'
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, color: 'var(--accent)', letterSpacing: 0.5 }}>
                    {r.title || r.site || 'Link'}
                  </span>
                  <span style={{
                    fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: 1,
                    padding: '1px 5px', borderRadius: 3,
                    background: r.free ? 'rgba(76,175,125,0.12)' : 'rgba(193,127,58,0.12)',
                    color: r.free ? 'var(--green)' : 'var(--accent)',
                    border: `1px solid ${r.free ? 'rgba(76,175,125,0.3)' : 'rgba(193,127,58,0.3)'}`,
                  }}>
                    {r.free ? 'FREE' : 'PAID'}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  {r.description || r.url}
                </div>
                {r.site && (
                  <div style={{ fontSize: 9, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                    {r.site}
                  </div>
                )}
              </a>
            ))}
          </div>
          {msg.onApplyUrl && msg.searchResults[0]?.url && (
            <button onClick={() => msg.onApplyUrl(msg.searchResults[0].url)}
              style={{ width: '100%', marginTop: 8, padding: '5px', background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#0d0d0f', fontFamily: 'var(--font-display)', fontSize: 13, letterSpacing: 1, cursor: 'pointer' }}>
              SET AS SOURCE URL
            </button>
          )}
        </div>
      )}

      {/* Suggestions */}
      {msg.suggestions && (
        <div style={{ maxWidth: '88%', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {msg.suggestions.tags && (
            <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 6 }}>
                Suggested Tags
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                {msg.suggestions.tags.map(t => (
                  <span key={t}
                    onClick={() => msg.onApplyTag && msg.onApplyTag(t)}
                    style={{
                      background: 'var(--bg4)', border: '1px solid var(--border-bright)', borderRadius: 3,
                      padding: '2px 8px', fontSize: 11, color: 'var(--text)', cursor: 'pointer',
                      transition: 'all 0.12s'
                    }}
                    onMouseEnter={e => { e.target.style.borderColor = 'var(--accent)'; e.target.style.color = 'var(--accent)'; }}
                    onMouseLeave={e => { e.target.style.borderColor = 'var(--border-bright)'; e.target.style.color = 'var(--text)'; }}
                    title="Click to add tag">
                    + {t}
                  </span>
                ))}
              </div>
              <button onClick={() => msg.onApplyAllTags && msg.onApplyAllTags(msg.suggestions.tags)}
                style={{ width: '100%', padding: '5px', background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#0d0d0f', fontFamily: 'var(--font-display)', fontSize: 13, letterSpacing: 1, cursor: 'pointer' }}>
                ADD ALL TAGS
              </button>
            </div>
          )}

          {msg.suggestions.status && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Suggested status:</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)' }}>{msg.suggestions.status}</span>
              <button onClick={() => msg.onApplyStatus && msg.onApplyStatus(msg.suggestions.status)}
                style={{ marginLeft: 'auto', padding: '3px 10px', background: 'var(--accent)', border: 'none', borderRadius: 3, color: '#0d0d0f', fontFamily: 'var(--font-display)', fontSize: 12, letterSpacing: 1, cursor: 'pointer' }}>
                APPLY
              </button>
            </div>
          )}

          {msg.suggestions.notes && (
            <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 6 }}>
                Suggested Notes
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 8 }}>
                {msg.suggestions.notes}
              </div>
              <button onClick={() => msg.onApplyNotes && msg.onApplyNotes(msg.suggestions.notes)}
                style={{ width: '100%', padding: '5px', background: 'var(--bg4)', border: '1px solid var(--border-bright)', borderRadius: 4, color: 'var(--text)', fontFamily: 'var(--font-display)', fontSize: 13, letterSpacing: 1, cursor: 'pointer' }}>
                USE THESE NOTES
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ClaudeAssistant({ model, apiKey, onApplyTag, onApplyAllTags, onApplyStatus, onApplyNotes, onApplyUrl, onApiKeyChange }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showApiKeyInput, setShowApiKeyInput] = useState(!apiKey);
  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey || '');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    setShowApiKeyInput(!apiKey);
  }, [apiKey]);

  const sendMessage = async (userText, action = null) => {
    if (!apiKey) { setShowApiKeyInput(true); return; }
    if (!userText.trim() && !action) return;

    const userMsg = { role: 'user', content: userText || QUICK_ACTIONS.find(a => a.id === action)?.label || '' };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      // Web search action uses a separate endpoint
      if (action === 'find_online' || (userText && /\b(find|search|where|buy|download|link|url|source)\b/i.test(userText))) {
        const r = await fetch('/api/ai/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-claude-key': apiKey },
          body: JSON.stringify({
            modelId: model.id,
            query: action === 'find_online' ? null : userText
          })
        });

        const data = await r.json();
        if (!r.ok) throw new Error(data.error);

        const assistantMsg = {
          role: 'assistant',
          content: data.text || 'Here\'s what I found:',
          searchResults: data.results || [],
          onApplyUrl,
        };

        setMessages(prev => [...prev, assistantMsg]);
      } else {
        // Regular assist
        const history = messages.map(m => ({ role: m.role, content: m.content }));

        const r = await fetch('/api/ai/assist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-claude-key': apiKey },
          body: JSON.stringify({
            modelId: model.id,
            action,
            userMessage: action ? null : userText,
            history
          })
        });

        const data = await r.json();
        if (!r.ok) throw new Error(data.error);

        const assistantMsg = {
          role: 'assistant',
          content: data.text || '(no response)',
          suggestions: {
            tags: data.suggestedTags,
            status: data.suggestedStatus,
            notes: data.suggestedNotes
          },
          onApplyTag,
          onApplyAllTags,
          onApplyStatus,
          onApplyNotes
        };

        setMessages(prev => [...prev, assistantMsg]);
      }
    } catch (e) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${e.message}`,
      }]);
    }
    setLoading(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  };

  const handleSaveKey = () => {
    onApiKeyChange(apiKeyDraft.trim());
    setShowApiKeyInput(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>✦</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 16, letterSpacing: 1, color: 'var(--accent)' }}>CLAUDE</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', letterSpacing: 1 }}>AI ASSISTANT</span>
        </div>
        <button onClick={() => setShowApiKeyInput(s => !s)}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-faint)', padding: '3px 8px', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
          {apiKey ? '🔑 Key set' : '🔑 Add key'}
        </button>
      </div>

      {/* API Key input */}
      {showApiKeyInput && (
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--bg3)', flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Enter your Anthropic API key to enable AI assistance. Your key is stored in your browser only and sent directly to The Vault's backend.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="password"
              value={apiKeyDraft}
              onChange={e => setApiKeyDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveKey(); }}
              placeholder="sk-ant-..."
              style={{ flex: 1, background: 'var(--bg4)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11, padding: '6px 8px', outline: 'none' }}
            />
            <button onClick={handleSaveKey}
              style={{ padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#0d0d0f', fontFamily: 'var(--font-display)', fontSize: 13, letterSpacing: 1, cursor: 'pointer' }}>
              SAVE
            </button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 6 }}>
            Get a key at <span style={{ color: 'var(--accent)' }}>console.anthropic.com</span>
          </div>
        </div>
      )}

      {/* Quick actions */}
      {messages.length === 0 && !showApiKeyInput && (
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 8 }}>Quick Actions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {QUICK_ACTIONS.map(a => (
              <button key={a.id} onClick={() => sendMessage('', a.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', textAlign: 'left', transition: 'border-color 0.12s' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                <span style={{ fontSize: 14 }}>{a.label.split(' ')[0]}</span>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text)' }}>{a.label.split(' ').slice(1).join(' ')}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{a.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 0' }}>
        {messages.map((msg, i) => (
          <Message key={i} msg={msg} />
        ))}
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: 'var(--text-muted)', fontSize: 12 }}>
            <div style={{ display: 'flex', gap: 3 }}>
              {[0,1,2].map(i => (
                <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', animation: `pulse 1s ease-in-out ${i * 0.2}s infinite` }} />
              ))}
            </div>
            Thinking...
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: 10, borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])}
            style={{ display: 'block', marginBottom: 6, background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
            ✕ clear chat
          </button>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={apiKey ? 'Ask anything about this model...' : 'Add an API key to chat'}
            disabled={!apiKey || loading}
            rows={2}
            style={{
              flex: 1, background: 'var(--bg3)', border: '1px solid var(--border)',
              borderRadius: 5, color: 'var(--text)', fontFamily: 'var(--font-body)',
              fontSize: 12, padding: '7px 9px', outline: 'none', resize: 'none',
              lineHeight: 1.4, opacity: !apiKey ? 0.5 : 1
            }}
          />
          <button onClick={() => sendMessage(input)} disabled={!apiKey || loading || !input.trim()}
            style={{ padding: '0 12px', background: 'var(--accent)', border: 'none', borderRadius: 5, color: '#0d0d0f', fontFamily: 'var(--font-display)', fontSize: 15, letterSpacing: 1, cursor: 'pointer', opacity: (!apiKey || !input.trim()) ? 0.4 : 1, alignSelf: 'stretch' }}>
            ↑
          </button>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 4 }}>Enter to send · Shift+Enter for new line</div>
      </div>

      <style>{`@keyframes pulse { 0%,100% { opacity:0.3; transform:scale(0.8); } 50% { opacity:1; transform:scale(1.1); } }`}</style>
    </div>
  );
}

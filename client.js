window.__ModuleLoader__.load({
  id: 'dsh-mood',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useCallback, useRef } = React;
    const h = React.createElement;

    const BASE_COLORS = {
      happy: '#f59e0b',
      sad: '#3b82f6',
      anger: '#ef4444',
      fear: '#8b5cf6',
      surprise: '#10b981',
      disgust: '#84cc16',
    };
    const BASE_LABELS = {
      happy: '乐', sad: '悲', anger: '怒', fear: '惧', surprise: '惊', disgust: '厌',
    };
    const BASE_ORDER = ['happy', 'sad', 'anger', 'fear', 'surprise', 'disgust'];

    // Pill component
    function MoodPill({ state, onClick }) {
      if (!state) return null;
      const dom = state.dominant;
      const label = dom?.label || '...';
      const bg = dom?.base && BASE_COLORS[dom.base] ? BASE_COLORS[dom.base] : '#6b7280';
      const activeStates = (state.states || []).filter(s => s.until > Date.now());
      const hasState = activeStates.length > 0;

      return h('button', {
        onClick,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 12, border: `1.5px solid ${bg}`,
          background: 'transparent', cursor: 'pointer',
          fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-text-primary, #d1d5db)',
          fontFamily: 'inherit',
        },
        title: hasState ? activeStates.map(s => s.name).join('、') : '',
      },
        h('span', {
          style: {
            width: 16, height: 16, borderRadius: '50%',
            background: bg, display: 'inline-block', flexShrink: 0,
          }
        }),
        label,
        hasState ? h('span', { style: { opacity: 0.7, fontSize: 10 } }, activeStates.map(s => s.name).join(' ')) : null,
      );
    }

    // Bar component
    function EmotionBar({ base, value, baseline }) {
      const pct = Math.min(100, Math.max(0, (value / 100) * 100));
      const blPct = baseline ? Math.min(100, Math.max(0, (baseline / 100) * 100)) : 0;
      const color = BASE_COLORS[base] || '#6b7280';

      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
        h('span', { style: { width: 16, fontSize: 12, textAlign: 'right', color: 'var(--dsw-alias-text-secondary, #9ca3af)' } }, BASE_LABELS[base]),
        h('div', { style: { flex: 1, height: 14, background: 'var(--dsw-alias-bg-tertiary, #374151)', borderRadius: 4, position: 'relative', overflow: 'hidden' } },
          h('div', {
            style: {
              width: pct + '%', height: '100%', background: color, borderRadius: 4,
              transition: 'width 0.3s ease',
            }
          }),
          baseline !== undefined ? h('div', {
            style: {
              position: 'absolute', left: blPct + '%', top: 0, bottom: 0,
              width: 2, background: 'var(--dsw-alias-text-primary, #fff)', opacity: 0.5,
            }
          }) : null,
        ),
        h('span', { style: { width: 36, fontSize: 11, textAlign: 'right', color: 'var(--dsw-alias-text-secondary, #9ca3af)', fontVariantNumeric: 'tabular-nums' } }, value.toFixed(1)),
      );
    }

    // Card (modal)
    function MoodCard({ state, onClose }) {
      const [view, setView] = useState('bars'); // 'bars' | 'log'
      const [logDate, setLogDate] = useState('');
      const [logEntries, setLogEntries] = useState([]);
      const [logBlock, setLogBlock] = useState('');

      useEffect(() => {
        const today = new Date().toISOString().slice(0, 10);
        setLogDate(today);
      }, []);

      const fetchLog = useCallback(async (date, block) => {
        try {
          const params = new URLSearchParams({ date });
          if (block) params.set('block', block);
          const resp = await fetch('/api/mood/log?' + params.toString());
          const data = await resp.json();
          setLogEntries(data.entries || []);
        } catch (e) {
          setLogEntries([]);
        }
      }, []);

      useEffect(() => {
        if (view === 'log' && logDate) {
          fetchLog(logDate, logBlock);
        }
      }, [view, logDate, logBlock, fetchLog]);

      if (!state) return null;

      const activeStates = (state.states || []).filter(s => s.until > Date.now());
      const BLOCK_OPTIONS = ['', '乐', '悲', '怒', '惧', '惊', '厌', '思念', '无聊', '状态'];

      return h('div', {
        style: {
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }
      },
        h('div', {
          onClick: onClose,
          style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }
        }),
        h('div', {
          style: {
            position: 'relative', width: 360, maxHeight: '80vh',
            background: 'var(--dsw-alias-bg-primary, #1f2937)',
            borderRadius: 12, padding: 20, overflowY: 'auto',
            color: 'var(--dsw-alias-text-primary, #d1d5db)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }
        },
          // Header
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 } },
            h('span', { style: { fontWeight: 600, fontSize: 16 } }, view === 'bars' ? '情绪面板' : '情绪日志'),
            h('div', { style: { display: 'flex', gap: 8 } },
              view === 'bars' ? h('button', {
                onClick: () => setView('log'),
                style: { background: 'none', border: '1px solid var(--dsw-alias-border, #4b5563)', borderRadius: 6, color: 'var(--dsw-alias-text-primary, #d1d5db)', padding: '2px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }
              }, '查看日志') : h('button', {
                onClick: () => setView('bars'),
                style: { background: 'none', border: '1px solid var(--dsw-alias-border, #4b5563)', borderRadius: 6, color: 'var(--dsw-alias-text-primary, #d1d5db)', padding: '2px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }
              }, '← 返回'),
              h('button', {
                onClick: onClose,
                style: { background: 'none', border: 'none', color: 'var(--dsw-alias-text-secondary, #9ca3af)', fontSize: 18, cursor: 'pointer', lineHeight: 1, fontFamily: 'inherit' }
              }, '×'),
            ),
          ),

          view === 'bars' ?
            // Bars view
            h('div', null,
              h('div', { style: { marginBottom: 12 } },
                ...BASE_ORDER.map(base =>
                  h(EmotionBar, { key: base, base, value: state.values[base] || 0, baseline: undefined })
                )
              ),
              state.missing ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #9ca3af)', marginBottom: 4 } },
                `思念：${(state.missing.value || 0).toFixed(1)}`
              ) : null,
              state.boredom ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #9ca3af)', marginBottom: 8 } },
                `无聊：${(state.boredom.value || 0).toFixed(1)}`
              ) : null,
              activeStates.length > 0 ? h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #4b5563)', paddingTop: 8 } },
                h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, '激活状态'),
                ...activeStates.map(s =>
                  h('div', { key: s.name, style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #9ca3af)', marginBottom: 2 } },
                    `${s.name}（触发：${s.from}，剩余 ${Math.max(0, Math.ceil((s.until - Date.now()) / 60000))}min）`
                  )
                )
              ) : null,
            )
          :
            // Log view
            h('div', null,
              h('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
                h('input', {
                  type: 'date', value: logDate,
                  onChange: e => setLogDate(e.target.value),
                  style: { background: 'var(--dsw-alias-bg-secondary, #374151)', color: 'var(--dsw-alias-text-primary, #d1d5db)', border: '1px solid var(--dsw-alias-border, #4b5563)', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: 'inherit' }
                }),
                h('select', {
                  value: logBlock,
                  onChange: e => setLogBlock(e.target.value),
                  style: { background: 'var(--dsw-alias-bg-secondary, #374151)', color: 'var(--dsw-alias-text-primary, #d1d5db)', border: '1px solid var(--dsw-alias-border, #4b5563)', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: 'inherit' }
                },
                  ...BLOCK_OPTIONS.map(b =>
                    h('option', { key: b, value: b }, b || '全部')
                  )
                ),
              ),
              h('div', { style: { maxHeight: 400, overflowY: 'auto', fontSize: 11 } },
                logEntries.length === 0 ?
                  h('div', { style: { color: 'var(--dsw-alias-text-secondary, #9ca3af)', textAlign: 'center', padding: 20 } }, '暂无记录')
                :
                  h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
                    h('thead', null,
                      h('tr', null,
                        h('th', { style: textCellStyle }, '时间'),
                        h('th', { style: textCellStyle }, '情绪'),
                        h('th', { style: textCellStyle }, '变化'),
                        h('th', { style: textCellStyle }, '原因'),
                      )
                    ),
                    h('tbody', null,
                      ...logEntries.map((e, i) =>
                        h('tr', { key: i, style: { borderTop: '1px solid var(--dsw-alias-border, #374151)' } },
                          h('td', { style: textCellStyle }, e.time),
                          h('td', { style: textCellStyle }, e.emotion),
                          h('td', { style: { ...textCellStyle, fontVariantNumeric: 'tabular-nums' } }, e.delta),
                          h('td', { style: { ...textCellStyle, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.reason),
                        )
                      )
                    )
                  )
              ),
            )
        )
      );
    }

    const textCellStyle = {
      padding: '3px 6px', textAlign: 'left', fontSize: 11,
      color: 'var(--dsw-alias-text-primary, #d1d5db)',
      borderBottom: '1px solid var(--dsw-alias-border, #374151)',
    };

    // Main component
    function MoodWidget() {
      const [moodState, setMoodState] = useState(null);
      const [showCard, setShowCard] = useState(false);
      const timerRef = useRef(null);

      const fetchState = useCallback(async () => {
        try {
          const resp = await fetch('/api/mood/state');
          if (!resp.ok) return;
          const data = await resp.json();
          setMoodState(data);
        } catch (e) { /* server may not be ready */ }
      }, []);

      useEffect(() => {
        fetchState();
        timerRef.current = setInterval(fetchState, 30000);
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
      }, [fetchState]);

      return h('div', { style: { display: 'inline-flex', alignItems: 'center' } },
        h(MoodPill, { state: moodState, onClick: () => setShowCard(true) }),
        showCard ? h(MoodCard, { state: moodState, onClose: () => setShowCard(false) }) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'dsh-mood-pill', order: 20,
        }, MoodWidget));
      },
    };
  },
});
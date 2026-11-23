window.__ModuleLoader__.load({
  id: 'dsh-mood',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;

    const BASE_COLORS = {
      happy: '#f59e0b',
      sad: '#3b82f6',
      anger: '#ef4444',
      fear: '#8b5cf6',
      surprise: '#10b981',
      disgust: '#84cc16',
    };
    const BASE_LABELS = { happy: '乐', sad: '悲', anger: '怒', fear: '惧', surprise: '惊', disgust: '厌' };
    const BASE_ORDER = ['happy', 'sad', 'anger', 'fear', 'surprise', 'disgust'];

    // ── shared store: one poll, two slots (pill in dock, card in overlay) ──
    const shared = {
      data: null,
      cardOpen: false,
      subs: new Set(),
    };
    function notify() { shared.subs.forEach(fn => fn()); }

    function useShared() {
      const [, force] = useState(0);
      useEffect(() => {
        // BUG FIX: store an updater, not the bare setState. Calling a bare
        // setter with no argument queues setState(undefined); after the
        // first render that is shallow-equal to the previous state, so
        // notify() silently stopped re-rendering — the card could open but
        // never close.
        const fn = () => force(x => x + 1);
        shared.subs.add(fn);
        return () => { shared.subs.delete(fn); };
      }, []);
      return shared;
    }

    async function fetchState() {
      try {
        const resp = await fetch('/api/mood/state');
        if (!resp.ok) return;
        const data = await resp.json();
        shared.data = data;
        notify();
      } catch (e) { /* server may not be ready */ }
    }

    // ── pill (conversation.composer.dock) ──
    function MoodPill() {
      const s = useShared();
      const state = s.data;
      if (!state) return null;
      const dom = state.dominant;
      const label = dom?.label || '…';
      const bg = dom?.base && BASE_COLORS[dom.base] ? BASE_COLORS[dom.base] : '#6b7280';
      const activeStates = (state.states || []).filter(x => x.until > Date.now());
      const hasState = activeStates.length > 0;

      return h('button', {
        onClick: () => {
          shared.cardOpen = true;
          notify();
          // Open should not wait for the 30s poll: fetch NOW.
          fetchState();
        },
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 12, border: `1.5px solid ${bg}`,
          background: 'transparent', cursor: 'pointer',
          fontSize: 12, lineHeight: '20px',
          color: 'var(--dsw-alias-text-primary, #d1d5db)',
          fontFamily: 'inherit',
        },
        title: hasState ? activeStates.map(x => x.name).join('、') : '',
      },
        h('span', {
          style: {
            width: 16, height: 16, borderRadius: '50%',
            background: bg, display: 'inline-block', flexShrink: 0,
          }
        }),
        label,
        hasState ? h('span', { style: { opacity: 0.7, fontSize: 10 } }, activeStates.map(x => x.name).join(' ')) : null,
      );
    }

    // ── bars ──
    function EmotionBar({ base, value, baseline }) {
      const pct = Math.min(100, Math.max(0, value));
      const color = BASE_COLORS[base] || '#6b7280';
      const bl = baseline == null ? null : Math.min(100, Math.max(0, baseline));
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
        h('span', { style: { width: 16, fontSize: 12, textAlign: 'right', color: 'var(--dsw-alias-text-secondary, #9ca3af)' } }, BASE_LABELS[base]),
        h('div', { style: { flex: 1, height: 14, background: 'var(--dsw-alias-bg-tertiary, #374151)', borderRadius: 4, position: 'relative', overflow: 'hidden' } },
          h('div', {
            style: { width: pct + '%', height: '100%', background: color, borderRadius: 4, transition: 'width 0.3s ease' }
          }),
          // Baseline mark: thin vertical line showing where "normal" is.
          bl != null ? h('div', {
            title: `基线 ${(+baseline).toFixed(0)}`,
            style: {
              position: 'absolute', left: `calc(${bl}% - 1px)`, top: 0, bottom: 0, width: 2,
              background: 'rgba(255,255,255,0.5)', zIndex: 1,
            }
          }) : null,
        ),
        h('span', { style: { width: 36, fontSize: 11, textAlign: 'right', color: 'var(--dsw-alias-text-secondary, #9ca3af)', fontVariantNumeric: 'tabular-nums' } }, value.toFixed(1)),
      );
    }

    const cellStyle = {
      padding: '3px 6px', textAlign: 'left', fontSize: 11,
      color: 'var(--dsw-alias-text-primary, #d1d5db)',
      borderBottom: '1px solid var(--dsw-alias-border, #374151)',
    };

    // ── card (shell.overlay) ──
    function MoodCard() {
      const s = useShared();
      const state = s.data;
      const [view, setView] = useState('bars'); // 'bars' | 'log'
      const [logDate, setLogDate] = useState('');
      const [logEntries, setLogEntries] = useState([]);
      const [logBlock, setLogBlock] = useState('');

      useEffect(() => {
        setLogDate(new Date().toISOString().slice(0, 10));
      }, []);

      const fetchLog = useCallback(async (date, block) => {
        try {
          const params = new URLSearchParams({ date });
          if (block) params.set('block', block);
          const resp = await fetch('/api/mood/log?' + params.toString());
          const data = await resp.json();
          // Newest first in the card's log view.
          setLogEntries((data.entries || []).slice().reverse());
        } catch (e) {
          setLogEntries([]);
        }
      }, []);

      useEffect(() => {
        if (view === 'log' && logDate) fetchLog(logDate, logBlock);
      }, [view, logDate, logBlock, fetchLog]);

      const close = () => { shared.cardOpen = false; notify(); };
      if (!state) return null;

      const activeStates = (state.states || []).filter(x => x.until > Date.now());
      const BLOCK_OPTIONS = ['', '乐', '悲', '怒', '惧', '惊', '厌', '思念', '无聊', '状态'];

      return h('div', {
        style: {
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }
      },
        h('div', { onClick: close, style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' } }),
        h('div', {
          style: {
            position: 'relative', width: 360, maxHeight: '80vh',
            background: 'var(--dsw-alias-bg-primary, #1f2937)',
            borderRadius: 12, padding: 20, overflowY: 'auto',
            color: 'var(--dsw-alias-text-primary, #d1d5db)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }
        },
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
                onClick: close,
                style: { background: 'none', border: 'none', color: 'var(--dsw-alias-text-secondary, #9ca3af)', fontSize: 18, cursor: 'pointer', lineHeight: 1, fontFamily: 'inherit' }
              }, '×'),
            ),
          ),

          view === 'bars' ?
            h('div', null,
              ...BASE_ORDER.map(base =>
                h(EmotionBar, { key: base, base, value: state.values[base] || 0, baseline: state.baseline?.[base] })
              ),
              state.missing ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #9ca3af)', marginTop: 8, marginBottom: 4 } },
                `思念：${(state.missing.value || 0).toFixed(1)}`) : null,
              state.boredom ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #9ca3af)', marginBottom: 8 } },
                `无聊：${(state.boredom.value || 0).toFixed(1)}`) : null,
              activeStates.length > 0 ? h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #4b5563)', paddingTop: 8 } },
                h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, '激活状态'),
                ...activeStates.map(x =>
                  h('div', { key: x.name, style: { fontSize: 12, color: 'var(--dsw-alias-text-secondary, #9ca3af)', marginBottom: 2 } },
                    `${x.name}（触发：${x.from}，剩余 ${Math.max(0, Math.ceil((x.until - Date.now()) / 60000))}min）`
                  )
                )
              ) : null,
            )
          :
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
                  ...BLOCK_OPTIONS.map(b => h('option', { key: b, value: b }, b || '全部'))
                ),
              ),
              h('div', { style: { maxHeight: 400, overflowY: 'auto', fontSize: 11 } },
                logEntries.length === 0 ?
                  h('div', { style: { color: 'var(--dsw-alias-text-secondary, #9ca3af)', textAlign: 'center', padding: 20 } }, '暂无记录')
                :
                  h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
                    h('thead', null,
                      h('tr', null,
                        h('th', { style: cellStyle }, '时间'),
                        h('th', { style: cellStyle }, '情绪'),
                        h('th', { style: cellStyle }, '变化'),
                        h('th', { style: cellStyle }, '原因'),
                      )
                    ),
                    h('tbody', null,
                      ...logEntries.map((e, i) =>
                        h('tr', { key: i },
                          h('td', { style: cellStyle }, e.time),
                          h('td', { style: cellStyle }, e.emotion),
                          h('td', { style: { ...cellStyle, fontVariantNumeric: 'tabular-nums' } }, e.delta),
                          h('td', { style: { ...cellStyle, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.reason),
                        )
                      )
                    )
                  )
              ),
            )
        )
      );
    }

    function MoodOverlay() {
      const s = useShared();
      if (!s.cardOpen) return null;
      return h(MoodCard);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // One poll feeding the shared store; both slots subscribe.
        const timer = setInterval(fetchState, 30000);

        // Immediate first fetch.
        fetchState();

        ctx.effect(() => () => clearInterval(timer), 'dsh-mood: poll');

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'dsh-mood-pill', order: 20,
        }, MoodPill));

        // C4: the card lives in the frame-wide overlay layer — outside the
        // composer's scroll/overflow containers — instead of fixed inside
        // the dock slot.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-mood-card', order: 100,
        }, MoodOverlay));
      },
    };
  },
});
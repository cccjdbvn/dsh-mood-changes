/**
 * dsh-mood-changes（Mood changes）的浏览器那一半。
 *
 * 输入框下面一枚小药丸，写着此刻的状态；按一下，往上弹一张卡：
 * 乐 / 悲 / 惧 / 怒 / 惊 / 厌，隔一条缝，思念 / 无聊。只报状态，不替人开口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mood-changes',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-mood-changes'
    const STATE_URL = '/api/dsh-mood-changes/state'
    const POLL_MS = 15000
    const SIX = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust']
    const EXTRA = ['missing', 'boredom']
    const FALLBACK = {
      title: '此刻',
      eyebrow: 'Mood changes',
      footer: '只报状态，不替你开口。',
      steady: '平稳',
      waiting: '还没算过',
      lit: '亮着',
      calm: '都没到 40',
      happy: '乐',
      sad: '悲',
      fear: '惧',
      anger: '怒',
      surprise: '惊',
      disgust: '厌',
      missing: '思念',
      boredom: '无聊',
    }
    const EN = {
      title: 'Now',
      eyebrow: 'Mood changes',
      footer: 'Status only. It never speaks for you.',
      steady: 'Steady',
      waiting: 'Not computed yet',
      lit: 'lit',
      calm: 'nothing above 40',
      happy: 'Joy',
      sad: 'Sorrow',
      fear: 'Fear',
      anger: 'Anger',
      surprise: 'Surprise',
      disgust: 'Disgust',
      missing: 'Longing',
      boredom: 'Boredom',
    }
    const COLORS = {
      happy: '#f0c05a',
      sad: '#6c8ebf',
      fear: '#a184e0',
      anger: '#e0605c',
      surprise: '#48c9c0',
      disgust: '#93a94e',
      missing: '#e08ab5',
      boredom: '#8b909a',
    }

    /** 两个半块（药丸、弹卡）共用的最小状态：轮询来的数据 + 开合 + 锚点。 */
    const shared = { data: null, open: false, rect: null, listeners: new Set() }
    const emit = () => {
      for (const listener of Array.from(shared.listeners)) listener()
    }
    const useShared = () => {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((n) => n + 1)
        shared.listeners.add(listener)
        return () => {
          shared.listeners.delete(listener)
        }
      }, [])
      return shared
    }

    const round1 = (value) => {
      const n = Number(value)
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0
    }

    function bar(value, color) {
      return h(
        'div',
        {
          style: {
            position: 'relative',
            height: 5,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.07)',
            overflow: 'hidden',
            flex: 1,
            minWidth: 0,
          },
        },
        h('div', {
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${Math.max(0, Math.min(100, value))}%`,
            background: color,
            borderRadius: 3,
            opacity: 0.92,
          },
        }),
      )
    }

    function row(key, values, t) {
      const value = round1(values[key])
      return h(
        'div',
        {
          key,
          style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 },
        },
        h(
          'span',
          {
            style: {
              width: 30,
              flex: 'none',
              fontSize: 12,
              color: COLORS[key],
              opacity: value > 0 ? 0.95 : 0.4,
            },
          },
          t(key),
        ),
        bar(value, COLORS[key]),
        h(
          'span',
          {
            style: {
              width: 34,
              flex: 'none',
              textAlign: 'right',
              fontSize: 11,
              color: 'rgba(255,255,255,0.5)',
              fontVariantNumeric: 'tabular-nums',
            },
          },
          String(Math.round(value)),
        ),
      )
    }

    function MoodPill(props) {
      const state = useShared()
      const t = typeof props.t === 'function' ? props.t : (key) => FALLBACK[key] ?? key
      const data = state.data
      const lit = Array.isArray(data?.lit) ? data.lit.length > 0 : false
      const label = data ? data.label : t('waiting')
      const dotColor = lit ? '#f0c05a' : 'rgba(255,255,255,0.35)'
      const ref = React.useRef(null)
      const toggle = () => {
        const element = ref.current
        if (element && typeof element.getBoundingClientRect === 'function') {
          const box = element.getBoundingClientRect()
          shared.rect = { top: box.top, left: box.left, width: box.width }
        }
        shared.open = !shared.open
        emit()
      }
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'center', padding: '2px 0 4px' } },
        h(
          'button',
          {
            ref,
            type: 'button',
            'data-mood-changes-pill': 'true',
            'aria-expanded': state.open ? 'true' : 'false',
            title: data ? `${data.label} · ${t('title')}` : t('waiting'),
            onClick: toggle,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 10px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.10)',
              background: state.open ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)',
              color: 'inherit',
              fontSize: 12,
              lineHeight: '16px',
              cursor: 'pointer',
              transition: 'background 120ms ease',
            },
          },
          h('span', {
            style: { width: 6, height: 6, borderRadius: 3, background: dotColor, display: 'inline-block' },
          }),
          h('span', null, label),
        ),
      )
    }

    function MoodPanel(props) {
      const state = useShared()
      const t = typeof props.t === 'function' ? props.t : (key) => FALLBACK[key] ?? key
      React.useEffect(() => {
        if (!state.open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            shared.open = false
            emit()
          }
        }
        const onDown = (event) => {
          const target = event.target
          if (target && typeof target.closest === 'function') {
            if (target.closest('[data-mood-changes-panel]') || target.closest('[data-mood-changes-pill]')) return
          }
          shared.open = false
          emit()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
        }
      }, [state.open])

      if (!state.open || !state.data) return null
      const data = state.data
      const values = data.values || {}
      const lit = Array.isArray(data.lit) ? data.lit : []
      const width = 420
      const rect = shared.rect
      const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
      const left = rect ? Math.max(8, Math.min(rect.left, viewportWidth - width - 8)) : 8
      const bottom = rect ? Math.max(8, viewportHeight - rect.top + 10) : 80
      const tick = Number(data.lastTickAt) || 0
      const minutes = tick > 0 ? Math.max(0, Math.round((Date.now() - tick) / 60000)) : null
      const clock = tick > 0 ? new Date(tick).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
      const sub = minutes === null ? '' : `${clock} 算的 · ${minutes} 分钟前 · ${lit.length > 0 ? `${t('lit')} ${lit.length} 条` : t('calm')}`
      return h(
        'div',
        {
          'data-mood-changes-panel': 'true',
          role: 'dialog',
          'aria-label': `${t('eyebrow')} · ${t('title')}`,
          style: {
            position: 'fixed',
            left,
            bottom,
            width,
            zIndex: 60,
            boxSizing: 'border-box',
            padding: '16px 20px 14px',
            borderRadius: 14,
            border: '1px solid rgba(255,255,255,0.07)',
            background: 'rgba(13,20,32,0.97)',
            boxShadow: '0 18px 44px rgba(0,0,0,0.5)',
            color: 'rgba(255,255,255,0.9)',
            backdropFilter: 'blur(6px)',
          },
        },
        h(
          'div',
          { style: { fontSize: 11, letterSpacing: 1, color: 'rgba(255,255,255,0.42)' } },
          `${t('eyebrow')} · ${t('title')}`,
        ),
        h(
          'div',
          {
            style: {
              marginTop: 6,
              fontSize: 22,
              fontWeight: 600,
              lineHeight: 1.35,
              color: lit.length > 0 ? '#f0c05a' : 'rgba(255,255,255,0.55)',
            },
          },
          data.label,
        ),
        h('div', { style: { marginTop: 6, marginBottom: 14, fontSize: 11, color: 'rgba(255,255,255,0.38)' } }, sub),
        SIX.map((key) => row(key, values, t)),
        h('div', { style: { height: 10 } }),
        EXTRA.map((key) => row(key, values, t)),
        h(
          'div',
          {
            style: {
              marginTop: 8,
              paddingTop: 10,
              borderTop: '1px solid rgba(255,255,255,0.06)',
              fontSize: 10.5,
              color: 'rgba(255,255,255,0.28)',
            },
          },
          t('footer'),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: FALLBACK, en: EN }), 'dsh-mood-changes: dictionaries')
        ctx.effect(() => {
          const load = () => {
            fetch(STATE_URL, { cache: 'no-store' })
              .then((res) => (res.ok ? res.json() : null))
              .then((next) => {
                if (next && next.values) {
                  shared.data = next
                  emit()
                }
              })
              .catch(() => {})
          }
          load()
          const timer = setInterval(load, POLL_MS)
          const wake = () => load()
          window.addEventListener('focus', wake)
          document.addEventListener('visibilitychange', wake)
          return () => {
            clearInterval(timer)
            window.removeEventListener('focus', wake)
            document.removeEventListener('visibilitychange', wake)
          }
        }, 'dsh-mood-changes: poll')
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-mood-changes-pill',
              order: 30,
              locale: NS,
            },
            MoodPill,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-mood-changes-panel',
              order: 60,
              locale: NS,
            },
            MoodPanel,
          ),
        )
      },
    }
  },
})

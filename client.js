window.__ModuleLoader__.load({
  id: 'dsh-mood-changes',
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
    const BASE_LABELS = { happy: '开心', sad: '伤心', anger: '生气', fear: '害怕', surprise: '惊讶', disgust: '厌恶' };
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
        const resp = await fetch('/dsh-mood-changes/state');
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
    function EmotionBar({ base, value, baseline, label, color }) {
      const pct = Math.min(100, Math.max(0, value));
      const barColor = color || BASE_COLORS[base] || '#6b7280';
      const barLabel = label || BASE_LABELS[base] || base;
      const bl = baseline == null ? null : Math.min(100, Math.max(0, baseline));
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
        h('span', { style: { width: 32, fontSize: 12, textAlign: 'right', color: 'var(--dsw-alias-text-secondary, #9ca3af)' } }, barLabel),
        h('div', { style: { flex: 1, height: 14, background: 'var(--dsw-alias-bg-tertiary, #374151)', borderRadius: 4, position: 'relative', overflow: 'hidden' } },
          h('div', {
            style: { width: pct + '%', height: '100%', background: barColor, borderRadius: 4, transition: 'width 0.3s ease' }
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

    // 面板「上次掷骰」一行（2026-11-24 用户需求）：思念 / 无聊分别显示上次
    // 掷骰命中与否、距现在多少分钟，如「思念：未掷中 · 524分钟前」。
    // 夜间 23:00–07:00 停掷（服务端 rollNightPaused）→ 直接写「夜晚停掷」。
    // lastRoll 为 0 = 还从没真正掷过骰（值没到阈值 / 有气无力）。
    function rollText(label, info, nightPaused) {
      if (nightPaused) return `${label}：夜晚停掷`;
      const last = info?.lastRoll || 0;
      if (!last) return `${label}：未掷过`;
      const mins = Math.max(0, Math.floor((Date.now() - last) / 60000));
      return `${label}：${info.lastRollHit ? '掷中' : '未掷中'} · ${mins}分钟前`;
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
          const resp = await fetch('/dsh-mood-changes/log?' + params.toString());
          const data = await resp.json();
          // 顺序由服务端给（E17：/log 按记录时间降序，最新在最上面）；
          // 这里不再反转，免得把时间序又倒回去。
          setLogEntries(data.entries || []);
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
              // Missing / boredom: same bar style, visually separated from the
              // six affects (no baseline concept, zero is their "normal").
              h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #4b5563)', margin: '10px 0 8px', paddingTop: 6, fontSize: 11, color: 'var(--dsw-alias-text-secondary, #9ca3af)', letterSpacing: 1 } }, '思念 / 无聊'),
              h(EmotionBar, { key: 'missing', base: 'missing', label: '思念', value: state.missing?.value || 0, color: '#ec4899' }),
              h(EmotionBar, { key: 'boredom', base: 'boredom', label: '无聊', value: state.boredom?.value || 0, color: '#94a3b8' }),
              // 上次掷骰状态（2026-11-24 用户需求）：一行小字，思念 / 无聊分列。
              h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #9ca3af)', margin: '2px 0 0' } },
                `${rollText('思念', state.missing, state.rollNightPaused)}　　${rollText('无聊', state.boredom, state.rollNightPaused)}`
              ),
              activeStates.length > 0 ? h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #4b5563)', paddingTop: 8, marginTop: 8 } },
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
                          // 变化列（2026-11-24）：服务端给 change = 块名+带符号数值
                          // （怒+5 / 悲-3 / 思念+3 / 无聊-12 / 回滚+0 / 状态行 —）。
                          // 日志 .md 仍是纯数值；老响应没有 change 时退回旧数值显示。
                          h('td', { style: { ...cellStyle, fontVariantNumeric: 'tabular-nums' } },
                            e.change != null ? e.change : e.delta),
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

    // ── settings tab (settings.plugins.tab, E19) ──
    // 2026-11-24 起插件配置页不再自动生成，插件自己注册一个 tab。配置存在
    // profile 的 cordis.patch.yml 里，客户端通过宿主半的
    // /dsh-mood-changes/config 读写；保存会让插件重载，所以保存完稍等再刷新。
    function fieldText(field, value) {
      if (field.kind === 'list') return Array.isArray(value) ? value.join('，') : '';
      return value == null ? '' : String(value);
    }

    function parseDraft(field, text) {
      if (field.kind === 'number') {
        const t = String(text ?? '').trim();
        if (t === '') return { blank: true, value: null };
        const n = Number(t);
        return Number.isFinite(n) ? { blank: false, value: n } : { error: '必须是数字' };
      }
      if (field.kind === 'list') {
        const list = String(text ?? '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
        return { blank: list.length === 0, value: list };
      }
      const s = String(text ?? '');
      return { blank: s.trim() === '', value: s };
    }

    const settingsInputStyle = {
      width: '100%', boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-secondary, #374151)',
      color: 'var(--dsw-alias-text-primary, #d1d5db)',
      border: '1px solid var(--dsw-alias-border, #4b5563)',
      borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: 'inherit',
    };

    const settingsButtonStyle = {
      background: 'none', border: '1px solid var(--dsw-alias-border, #4b5563)', borderRadius: 6,
      color: 'var(--dsw-alias-text-primary, #d1d5db)', padding: '3px 12px', fontSize: 12,
      cursor: 'pointer', fontFamily: 'inherit',
    };

    function SettingsField({ field, value, onChange }) {
      return h('div', { style: { marginBottom: 10 } },
        h('div', { style: { marginBottom: 3 } }, field.label),
        h('input', {
          value: value ?? '',
          onChange: e => onChange(e.target.value),
          style: settingsInputStyle,
        }),
        field.description
          ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #9ca3af)', marginTop: 2 } }, field.description)
          : null,
      );
    }

    const BASE_NAMES = { happy: '乐', sad: '悲', fear: '惧', anger: '怒', surprise: '惊', disgust: '厌' };
    const SETTINGS_BASE_ORDER = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];

    function MoodSettingsTab() {
      const [config, setConfig] = useState(null);
      const [configDraft, setConfigDraft] = useState({});
      const [tuning, setTuning] = useState(null);
      const [tuningDraft, setTuningDraft] = useState({});
      const [baseline, setBaseline] = useState(null);
      const [baselineDraft, setBaselineDraft] = useState({});
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');

      const loadAll = useCallback(async () => {
        setError('');
        try {
          const [cr, tr, br] = await Promise.all([
            fetch('/dsh-mood-changes/config', { cache: 'no-store' }),
            fetch('/dsh-mood-changes/tuning', { cache: 'no-store' }),
            fetch('/dsh-mood-changes/baseline', { cache: 'no-store' }),
          ]);
          const [cb, tb, bb] = await Promise.all([cr.json(), tr.json(), br.json()]);
          if (!cb.ok) throw new Error(cb.error || '读取插件配置失败');
          if (!tb.ok) throw new Error(tb.error || '读取运行参数失败');
          if (!bb.ok) throw new Error(bb.error || '读取基线失败');

          setConfig(cb);
          const cd = {};
          for (const field of cb.fields) cd[field.key] = fieldText(field, cb.values[field.key]);
          setConfigDraft(cd);

          setTuning(tb);
          const td = {};
          for (const field of tb.fields) td[field.path] = String(tb.values[field.path] ?? '');
          setTuningDraft(td);

          setBaseline(bb);
          const bd = {};
          for (const key of SETTINGS_BASE_ORDER) bd[key] = String(bb.values[key] ?? '');
          setBaselineDraft(bd);
        } catch (e) {
          setError(String(e?.message || e));
        }
      }, []);

      useEffect(() => { loadAll(); }, [loadAll]);

      const saveConfig = async () => {
        if (!config) return;
        const set = {};
        const unset = [];
        for (const field of config.fields) {
          const parsed = parseDraft(field, configDraft[field.key]);
          if (parsed.error) { setError(`${field.label}：${parsed.error}`); return; }
          const before = config.values[field.key];
          const same = parsed.blank
            ? (Array.isArray(before) ? before.length === 0 : before === '')
            : JSON.stringify(parsed.value) === JSON.stringify(before);
          if (same) continue;
          if (parsed.blank) unset.push(field.key);
          else set[field.key] = parsed.value;
        }
        if (Object.keys(set).length === 0 && unset.length === 0) { setNotice('插件配置没有改动'); return; }
        setBusy('config');
        setError('');
        setNotice('');
        try {
          const resp = await fetch('/dsh-mood-changes/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ set, unset }),
          });
          const body = await resp.json();
          if (!body.ok) throw new Error(body.error || '保存失败');
          setNotice('插件配置已保存，插件正在重载…');
          setTimeout(() => { loadAll(); }, 2500);
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy('');
        }
      };

      const saveTuning = async () => {
        if (!tuning) return;
        const set = {};
        for (const field of tuning.fields) {
          const text = String(tuningDraft[field.path] ?? '').trim();
          if (text === '') { setError(`${field.label} 不能为空`); return; }
          const value = Number(text);
          if (!Number.isFinite(value)) { setError(`${field.label} 必须是数字`); return; }
          if (value !== Number(tuning.values[field.path])) set[field.path] = value;
        }
        if (Object.keys(set).length === 0) { setNotice('运行参数没有改动'); return; }
        setBusy('tuning');
        setError('');
        setNotice('');
        try {
          const resp = await fetch('/dsh-mood-changes/tuning', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ set }),
          });
          const body = await resp.json();
          if (!body.ok) throw new Error(body.error || '保存失败');
          setTuning(body);
          const td = {};
          for (const field of body.fields) td[field.path] = String(body.values[field.path] ?? '');
          setTuningDraft(td);
          setNotice('运行参数已保存，下一跳 tick 起生效');
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy('');
        }
      };

      const saveBaseline = async () => {
        const values = {};
        for (const key of SETTINGS_BASE_ORDER) {
          const text = String(baselineDraft[key] ?? '').trim();
          const value = Number(text);
          if (text === '' || !Number.isFinite(value)) { setError(`${BASE_NAMES[key]} 必须是数字`); return; }
          values[key] = value;
        }
        setBusy('baseline');
        setError('');
        setNotice('');
        try {
          const resp = await fetch('/dsh-mood-changes/baseline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values }),
          });
          const body = await resp.json();
          if (!body.ok) throw new Error(body.error || '保存失败');
          setBaseline(body);
          setNotice('基线已保存；低于新基线的当前值会被补齐');
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy('');
        }
      };

      const sectionTitle = { fontSize: 12, fontWeight: 600, margin: '14px 0 6px', paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border, #4b5563)' };
      const subTitle = { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #9ca3af)', margin: '6px 0 4px', letterSpacing: 1 };
      const groups = tuning ? [...new Set(tuning.fields.map(f => f.group))] : [];

      return h('div', { style: { padding: '4px 2px', fontSize: 12 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '情绪插件'),
        h('div', { style: { color: 'var(--dsw-alias-text-secondary, #9ca3af)', marginBottom: 10, lineHeight: 1.5 } },
          '插件配置保存后插件会重载；运行参数和基线保存即生效。留空 = 用默认值。'
        ),
        error ? h('div', { style: { color: '#f87171', marginBottom: 8 } }, error) : null,
        !config || !tuning || !baseline
          ? h('div', { style: { color: 'var(--dsw-alias-text-secondary, #9ca3af)' } }, '读取中…')
          : h('div', null,
              // ── 插件配置 ──
              h('div', { style: { fontSize: 12, fontWeight: 600, margin: '4px 0 8px' } }, '插件配置'),
              ...config.fields.map(field => h(SettingsField, {
                key: field.key,
                field,
                value: configDraft[field.key] ?? '',
                onChange: (text) => setConfigDraft(prev => ({ ...prev, [field.key]: text })),
              })),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } },
                h('button', { onClick: saveConfig, disabled: busy === 'config', style: settingsButtonStyle }, busy === 'config' ? '保存中…' : '保存插件配置'),
                h('button', { onClick: loadAll, disabled: Boolean(busy), style: settingsButtonStyle }, '重新读取'),
              ),
              config.editable === false
                ? h('div', { style: { color: '#fbbf24', marginTop: 6 } }, '当前 profile 里写不了插件配置（configEditor 不可用），这里只能看不能改。')
                : null,

              // ── 运行参数（按增速 / 衰减 / 冷却 / 夜间分块） ──
              h('div', { style: sectionTitle }, '运行参数'),
              ...groups.map(group => h('div', { key: group },
                h('div', { style: subTitle }, group),
                ...tuning.fields.filter(field => field.group === group).map(field => h(SettingsField, {
                  key: field.path,
                  field,
                  value: tuningDraft[field.path] ?? '',
                  onChange: (text) => setTuningDraft(prev => ({ ...prev, [field.path]: text })),
                })),
              )),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } },
                h('button', { onClick: saveTuning, disabled: busy === 'tuning', style: settingsButtonStyle }, busy === 'tuning' ? '保存中…' : '保存运行参数'),
              ),

              // ── 情绪基线 ──
              h('div', { style: sectionTitle }, '情绪基线'),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                ...SETTINGS_BASE_ORDER.map(key => h('div', { key },
                  h('div', { style: { marginBottom: 2 } }, BASE_NAMES[key]),
                  h('input', {
                    value: baselineDraft[key] ?? '',
                    onChange: e => setBaselineDraft(prev => ({ ...prev, [key]: e.target.value })),
                    style: settingsInputStyle,
                  }),
                )),
              ),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
                h('button', { onClick: saveBaseline, disabled: busy === 'baseline', style: settingsButtonStyle }, busy === 'baseline' ? '保存中…' : '保存基线'),
                notice ? h('span', { style: { color: 'var(--dsw-alias-text-secondary, #9ca3af)' } }, notice) : null,
              ),
            ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // One poll feeding the shared store; both slots subscribe.
        const timer = setInterval(fetchState, 30000);

        // Immediate first fetch.
        fetchState();

        ctx.effect(() => () => clearInterval(timer), 'dsh-mood-changes: poll');

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          // order 25：与 breezetts 语音条（order 20）错开，固定排在语音条后面。
          // 之前两边都是 20 平局，重启后加载顺序一变胶囊就换位。
          name: 'conversation.composer.dock', id: 'dsh-mood-changes-pill', order: 25,
        }, MoodPill));

        // C4: the card lives in the frame-wide overlay layer — outside the
        // composer's scroll/overflow containers — instead of fixed inside
        // the dock slot.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-mood-changes-card', order: 100,
        }, MoodOverlay));

        // 设置界面（E19/E20，2026-11-24）：插件配置页不再自动生成，要插件自己注册。
        // 两处都注册，原因见《DSH插件设置页改造配方》：
        //   - settings.plugins.tab：只是「插件」页里的一个 tab；这一版的「插件」
        //     section 是否显示由 DSH 自己决定，不显示就等于没注册。
        //   - settings.section：左侧导航的独立一整页，跟「世界控制台」「皮肤」一样，
        //     不依赖「插件」section 是否可见。
        // 包在 ctx.inject(['slots']) + setTimeout(0) 里：等 slots 服务就绪再注册，
        // 旧版 DSH 上让原生服务先注册；slot 不存在时兜住异常，别拖垮整个 apply。
        ctx.inject(['slots'], (scoped) => {
          setTimeout(() => {
            const register = (slot, id, order) => {
              try {
                scoped.slots.inject(slot, () => scoped.slots.register({
                  name: slot, id, order, label: () => '情绪插件',
                }, MoodSettingsTab));
              } catch (error) {
                console?.debug?.(`dsh-mood-changes: ${slot} unavailable (${error?.message ?? error})`);
              }
            };
            register('settings.section', 'dsh-mood-changes', 29);
            register('settings.plugins.tab', 'dsh-mood-changes', 90);
          }, 0);
        });
      },
    };
  },
});
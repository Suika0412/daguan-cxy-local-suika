(function (root) {
  'use strict';
  const prefix = 'daguan_study_event_v1:', restorePrefix = 'daguan_study_restore_v1:';
  const cacheKey = 'daguan_study_backup_cache_v1';
  const endpoint = './api/study-activity';
  let flushing = null, active = null, feed = '', stopped = false, paused = false;
  let handshakePromise = null, lastFailure = null;
  let lastEmittedAt = 0;
  let savedSessions = {};
  try { savedSessions = JSON.parse(sessionStorage.getItem('daguan_study_sessions_v1') || '{}'); } catch {}
  const sessions = new Map(Object.entries(savedSessions.sessions || {}));
  active = savedSessions.active || null; feed = savedSessions.feed || '';
  const saveSessions = () => sessionStorage.setItem('daguan_study_sessions_v1', JSON.stringify({ active, feed, sessions: Object.fromEntries(sessions) }));
  const uuid = () => root.crypto.randomUUID();
  const notify = () => root.dispatchEvent(new CustomEvent('daguan:study-activity'));
  function fail(code, message, extra = {}) {
    const error = new Error(message);
    error.code = code;
    return Object.assign(error, extra);
  }
  // 共享清除代次契约来自 web/ui-version.js；缺失即显式报错，不在本文件另写一套。
  function progressResetApi() {
    const api = root.DaguanVersions && root.DaguanVersions.progressReset;
    if (!api) throw fail('PROGRESS_RESET_UNAVAILABLE', '缺少共享清除代次模块，无法确认学习记录代次');
    return api;
  }
  // 失败必须可见：记录最近错误、写 console 并派发事件，供界面显示；后台调用因此不会产生未处理拒绝。
  function reportFailure(error, context) {
    lastFailure = { code: error?.code || 'STUDY_ACTIVITY_FAILED', message: String(error?.message || error), context, at: new Date().toISOString() };
    if (typeof console !== 'undefined' && typeof console.error === 'function') console.error('[study-activity]', context, lastFailure.code, lastFailure.message);
    if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('daguan:study-activity-error', { detail: lastFailure }));
    return false;
  }
  // 学习战报快照必须与「请求捕获代次、当前页面代次、快照自带代次」三者一致，否则显式失败且不返回旧快照。
  // 老安装的备份/导出文档缺 reset_generation：由共享 helper 按缺失=0 兼容，非法值仍显式报错。
  function assertSnapshotGeneration(data, generation, message) {
    const api = progressResetApi();
    const dataGeneration = api.generationOf(data);
    if (dataGeneration !== generation || api.current() !== generation || !api.isCurrent(generation)) {
      throw fail('PROGRESS_RESET_STALE_EXPORT', message);
    }
    return data;
  }
  // 首次 flush/export/restore 前必须握手并 adopt（并发调用共用同一次 GET）。
  async function handshake() {
    if (!handshakePromise) {
      handshakePromise = (async () => {
        const response = await fetch('./api/state', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw fail('STATE_HANDSHAKE_FAILED', `状态握手失败（HTTP ${response.status}）`, { status: response.status });
        const state = await response.json();
        progressResetApi().adopt(state);
        return state;
      })().finally(() => { handshakePromise = null; });
    }
    return handshakePromise;
  }
  function cacheSnapshot(data, generation) {
    try {
      const previous = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (!previous || (data.revision || 0) >= (previous.revision || 0)) localStorage.setItem(cacheKey, JSON.stringify({ ...data, reset_generation: generation }));
    } catch {
      // Never fall back to an older, incomplete backup after quota exhaustion.
      localStorage.removeItem(cacheKey);
    }
  }
  function validateBackup(data) {
    if (data == null) return;
    if (data.version !== 1 || !data.events || typeof data.events !== 'object' || Array.isArray(data.events) ||
        !data.baseline || typeof data.baseline !== 'object' || Array.isArray(data.baseline) || !Number.isFinite(Date.parse(data.started_at))) throw new Error('学习战报备份格式无效');
    for (const e of Object.values(data.events)) {
      if (!e || !/^[\w-]{8,100}$/.test(e.event_id || '') || !/^\d+$/.test(String(e.question_id || '')) ||
          !['study', 'answer', 'reveal', 'favorite'].includes(e.type) || !Number.isFinite(Date.parse(e.at)) || Date.parse(e.at) > Date.now() + 60000 ||
          e.type === 'answer' && typeof e.correct !== 'boolean' || e.type === 'favorite' && !['manual', 'automatic'].includes(e.source)) throw new Error('学习战报备份包含无效事件');
    }
  }
  function keys(prefixValue) {
    const result = [];
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key.startsWith(prefixValue)) result.push(key); }
    return result;
  }
  async function request(suffix = '', method = 'GET', value) {
    const response = await fetch(endpoint + suffix, { method, cache: 'no-store',
      headers: value ? { 'Content-Type': 'application/json' } : {}, body: value ? JSON.stringify(value) : undefined,
      signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      // 错误体可能不是 JSON：此时仍按 HTTP 状态显式失败，不掩盖真实错误。
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      const message = response.status === 403 ? '学习战报需要解锁个人功能'
        : response.status === 428 ? String(payload?.error || '做题记录已清除，请刷新页面后重试')
        : '学习战报暂未同步，已保存本机，联网后重试';
      throw fail(payload?.code || `HTTP_${response.status}`, message, { status: response.status, current: payload?.current || null });
    }
    return response.json();
  }
  // 请求体携带发起时捕获的代次；428 代表代次过期：采纳服务端 current 并废弃本批，绝不重标记旧 payload 重试。
  async function send(path, payload) {
    const api = progressResetApi();
    const generation = api.capture();
    // 捕获后、发请求前再核对：共享 storage 已被别的窗口推进时，本批旧练习直接作废，不重新贴标签。
    if (!api.isCurrent(generation)) throw fail('PROGRESS_RESET_STALE_BATCH', '本机学习记录代次已更新，本批旧练习已作废', { discarded: true });
    try {
      const result = await request(path, 'POST', { ...payload, reset_generation: generation });
      return { result, generation };
    } catch (error) {
      if (error.status === 428) {
        error.discarded = true;
        if (error.current) progressResetApi().adopt(error.current);
      }
      throw error;
    }
  }
  function session(id) {
    id = String(id);
    if (!sessions.has(id)) sessions.set(id, { id: uuid(), seen: false });
    saveSessions();
    return sessions.get(id);
  }
  function emit(type, id, details = {}) {
    if (!/^\d+$/.test(String(id || ''))) return;
    const s = session(id);
    // 本页事件时间必须严格递增：作答与它触发的揭示常在同一毫秒产生，at 相同时服务端按到达序排序，
    // reveal 会抢在 answer 之前把该题标成“已看答案”，让正确首答不再计一遍过。
    lastEmittedAt = Math.max(Date.now(), lastEmittedAt + 1);
    const event = { event_id: uuid(), question_id: String(id), type, at: new Date(lastEmittedAt).toISOString(),
      session_id: s.id, answer_seen: s.seen, ...details };
    localStorage.setItem(prefix + event.event_id, JSON.stringify(event));
    notify();
    if (!paused) void flush();
  }
  async function flush() {
    if (paused) return reportFailure(fail('PROGRESS_RESET_PAUSED', '正在清除本机记录，学习写入已暂停'), 'flush');
    if (flushing) return flushing;
    flushing = (async () => {
      let changed = false;
      try {
        await handshake();
        for (const key of keys(restorePrefix)) {
          const backup = JSON.parse(localStorage.getItem(key));
          const { generation } = await send('/merge', backup);
          // 响应前后代次变化：不再删除/写缓存，代次清场已由 adopt 完成。
          if (!progressResetApi().isCurrent(generation)) break;
          localStorage.removeItem(key); changed = true;
        }
        while (!stopped) {
          const batchKeys = keys(prefix).slice(0, 250);
          if (!batchKeys.length) break;
          const batch = batchKeys.map(key => JSON.parse(localStorage.getItem(key)));
          const { result, generation } = await send('/events', { events: batch });
          if (!progressResetApi().isCurrent(generation)) break;
          for (const id of result.accepted) localStorage.removeItem(prefix + id);
          changed = true;
        }
      } catch (error) {
        return reportFailure(error, 'flush');
      }
      if (changed) {
        const generation = progressResetApi().current();
        try {
          const data = await request('/export');
          cacheSnapshot(assertSnapshotGeneration(data, generation, '学习战报代次已变化，本轮缓存未写入'), generation);
        } catch (error) {
          reportFailure(error, 'flush-export');
        }
        notify();
      }
      return true;
    })().finally(() => { flushing = null; });
    return flushing;
  }
  root.DaguanStudyActivity = {
    beginSingle(id) {
      if (active !== String(id)) { if (!feed.split(',').includes(String(id))) sessions.delete(String(id)); active = String(id); }
      feed = ''; saveSessions();
    },
    beginFeed(ids) {
      const next = ids.map(String).join(',');
      if (next !== feed) { for (const id of ids) if (String(id) !== active) sessions.delete(String(id)); feed = next; saveSessions(); }
    },
    study(id, details) { emit('study', id, details); },
    answer(id, correct, reliable, details) { emit('answer', id, { ...details, correct, reliable }); },
    reveal(id) { const s = session(id); if (!s.seen) { emit('reveal', id); s.seen = true; saveSessions(); } },
    favorite(id, source, details) { emit('favorite', id, { ...details, source }); },
    flush,
    handshake,
    validateBackup,
    // 清除前暂停：先挡住新 flush，再等待已在飞的那次给出明确结果；只等既有 promise，不会等自身。
    async pauseForReset() {
      paused = true;
      const inFlight = flushing;
      if (!inFlight) return true;
      let timer = 0;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('PROGRESS_RESET_PAUSE_TIMEOUT', '等待学习记录写入超时，请稍后重试')), 10000);
      });
      try {
        const outcome = await Promise.race([inFlight.then(value => ({ value }), error => ({ error })), timeout]);
        if (outcome.error) throw outcome.error;
        return outcome.value;
      } finally {
        clearTimeout(timer);
      }
    },
    // 释放暂停：不删除任何 events/restore 键，清除失败时原队列原样保留并重试。
    async resumeAfterReset() {
      paused = false;
      return flush();
    },
    lastFailure: () => lastFailure,
    async summary(days) {
      await flush();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return request(`?days=${days}&timeZone=${encodeURIComponent(timeZone)}`);
    },
    async journal(end = '') {
      await flush();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const response = await fetch(`${endpoint}/journal?end=${encodeURIComponent(end)}&timeZone=${encodeURIComponent(timeZone)}`, {
        cache: 'no-store', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(response.status === 403 ? '请先解锁个人功能，再查看学习手账' : '学习记录读取失败，请检查本地服务后重试');
      return response.json();
    },
    async export() {
      await flush();
      const reset = progressResetApi();
      const generation = reset.capture();
      let data;
      try {
        data = await request('/export');
      } catch (error) {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (!cached) throw error;
        data = assertSnapshotGeneration(cached, generation, '本机学习战报缓存属于清除前的记录，请联网后重新读取');
      }
      assertSnapshotGeneration(data, generation, '学习战报属于清除前的记录，请刷新后重新读取');
      cacheSnapshot(data, generation);
      for (const key of keys(prefix)) { const e = JSON.parse(localStorage.getItem(key)); data.events[e.event_id] = e; }
      for (const key of keys(restorePrefix)) {
        const pending = JSON.parse(localStorage.getItem(key));
        Object.assign(data.events, pending.events); Object.assign(data.baseline, pending.baseline);
        if (pending.started_at < data.started_at) data.started_at = pending.started_at;
      }
      return data;
    },
    async restore(data, progress) {
      if (!data && progress) {
        const baseline = {};
        for (const [id, p] of Object.entries(progress)) if (p && (p.seen || p.answered || p.last_practiced_at || ['learning', 'mastered', 'forgot'].includes(p.mastery))) baseline[id] = { failed: false };
        data = { version: 1, started_at: new Date().toISOString(), events: {}, baseline, importedBaseline: true };
      }
      if (!data) return;
      validateBackup(data);
      // 显式用户导入：先握手确认代次，再排入当前代次队列；不会因备份自带的旧代次被拒。
      await handshake();
      localStorage.setItem(restorePrefix + uuid(), JSON.stringify(data));
      await flush(); notify();
    },
    pendingCount: () => keys(prefix).length + keys(restorePrefix).length,
  };
  root.addEventListener('online', () => { void flush(); });
  // 共享 helper 已负责 storage 清理；这里只重置本页内存会话与本页 sessionStorage。
  root.addEventListener('daguan:progress-reset', () => {
    sessions.clear(); active = null; feed = ''; stopped = false;
    sessionStorage.removeItem('daguan_study_sessions_v1');
    notify();
  });
  // 后台预热缓存：失败必须显式记录，避免未处理拒绝；代次不一致的快照不写缓存。
  void (async () => {
    try {
      await handshake();
      const reset = progressResetApi();
      const generation = reset.current();
      const data = await request('/export');
      cacheSnapshot(assertSnapshotGeneration(data, generation, '预热缓存代次不一致，未写入'), generation);
    } catch (error) {
      reportFailure(error, 'warm-cache');
    }
  })();
  root.addEventListener('storage', e => { if (e.key?.startsWith(prefix) || e.key?.startsWith(restorePrefix)) notify(); });
  root.addEventListener('beforeunload', () => { stopped = true; });
  function scheduleLearningDay() {
    const now = new Date(), next = new Date(now);
    next.setHours(4, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => { notify(); scheduleLearningDay(); }, next.getTime() - now.getTime());
  }
  scheduleLearningDay();
  // Covers remote quick mode, which does not expose SSE, as well as missed
  // cross-window notifications and the 04:00 learning-day boundary.
  setInterval(() => { if (document.visibilityState !== 'hidden') notify(); if (keys(prefix).length || keys(restorePrefix).length) void flush(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { notify(); void flush(); } });
})(window);

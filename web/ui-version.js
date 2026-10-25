/* Shared bootstrap: appearance is separate; learning data keeps its existing keys. */
(function (root) {
  "use strict";
  const selectionKey = "daguan_ui_version_v1";
  const appearanceKeys = { new: "daguan_ui_appearance_new_v1", old: "daguan_ui_appearance_old_v1" };
  const appearanceInitKey = "daguan_ui_appearance_new_initialized_v1";
  const freshAppearance = { theme: "path-red", brand: "#C83F32", app: "#F7F3EA", reading: "#FFFEFA", accent: "#9A7746" };
  const orangeAppearance = { theme: "orange-white", brand: "#FF6A1A", app: "#F5F6F8", reading: "#FFFFFF", accent: "#B83D00" };
  function readObject(storage, key) {
    try { const value = JSON.parse(storage.getItem(key)); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
  }
  function migrate(storage) {
    if (!storage) return;
    // Capture device history before this bootstrap creates any appearance keys.
    const hadDeviceHistory = [selectionKey, appearanceKeys.old, "daguan_ui_appearance_new", "daguan_ui_preferences_v1",
      "daguan_learning_position_v2", "daguan_local_progress_v1", "daguan_local_favorites_v1",
      "daguan_question_annotations_v1", "daguan_local_notes_v1", "daguan_ai_preferences_v1", "ui-background", "ui-font"]
      .some(key => storage.getItem(key) !== null);
    if (storage.getItem(appearanceKeys.old) === null) {
      storage.setItem(appearanceKeys.old, JSON.stringify(readObject(storage, "daguan_ui_preferences_v1")));
    }
    const raw = storage.getItem(appearanceKeys.new);
    if (raw === null) {
      let initial = hadDeviceHistory ? orangeAppearance : freshAppearance;
      try {
        const legacyNew = readObject(storage, "daguan_ui_appearance_new");
        if (Object.keys(legacyNew).length) {
          const legacyTheme = legacyNew.theme === "light" ? "orange-white" : legacyNew.theme === "official-dark" ? "orange-night" : legacyNew.theme === "eye-care" ? "eye-care" : legacyNew.theme;
          initial = { ...orangeAppearance, ...legacyNew, theme: legacyTheme || "orange-white" };
        }
      } catch {}
      storage.setItem(appearanceKeys.new, JSON.stringify(initial));
      storage.setItem(appearanceInitKey, hadDeviceHistory ? "existing-device" : "fresh-install");
      return;
    }
    if (storage.getItem(appearanceInitKey) === null) storage.setItem(appearanceInitKey, "existing-device");
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // Earlier bootstrap versions wrote {} or theme:light on existing installs.
        if (!Object.keys(value).length || value.theme === "light") {
          storage.setItem(appearanceKeys.new, JSON.stringify({ ...orangeAppearance, reduceMotion: !!value.reduceMotion }));
        } else if (value.theme === "official-dark") {
          storage.setItem(appearanceKeys.new, JSON.stringify({ ...orangeAppearance, theme: "orange-night" }));
        } else if (value.theme === "eye-care") {
          storage.setItem(appearanceKeys.new, JSON.stringify({ ...orangeAppearance, theme: "eye-care" }));
        }
      }
    } catch { storage.setItem(appearanceKeys.new, JSON.stringify(hadDeviceHistory ? orangeAppearance : freshAppearance)); }
  }
  function selected(storage) { return storage.getItem(selectionKey) === "old" ? "old" : "new"; }
  function targetUrl(href, version, switching = false) {
    const url = new URL(href);
    url.pathname = url.pathname.replace(/[^/]*$/, version === "old" ? "legacy.html" : "index.html");
    if (switching) url.searchParams.set("uiSwitch", "1");
    return url.href;
  }
  function draftKey(questionId) { return `daguan_ai_draft_v1:${questionId}`; }

  // ---- 待同步日志（新版/旧版共用，键 daguan_pending_sync_v1） ----
  // 记录“本地已经写入、服务端尚未确认”的批注与收藏编辑，使离线、写入失败、刷新、
  // 跨版本切换都不会丢掉刚写入的本地编辑。日志只保存意图与内容指纹；真正推送的内容
  // 由调用方按 updated_at 取“本机最新值”，不会用日志里的旧快照覆盖更新的本地编辑。
  const pendingKey = "daguan_pending_sync_v1";
  function emptyPending() { return { version: 1, annotations: {}, questions: {} }; }
  function storageOf(storage) {
    if (storage && typeof storage.getItem === "function") return storage;
    return root.localStorage || null;
  }
  function readPending(storage) {
    const out = emptyPending();
    const store = storageOf(storage);
    if (!store) return out;
    let parsed = null;
    try { parsed = JSON.parse(store.getItem(pendingKey)); } catch { return out; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    const annotations = parsed.annotations;
    if (annotations && typeof annotations === "object" && !Array.isArray(annotations)) {
      for (const [id, entry] of Object.entries(annotations)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        out.annotations[String(id)] = {
          markdown: typeof entry.markdown === "string" ? entry.markdown : "",
          updated_at: typeof entry.updated_at === "string" ? entry.updated_at : null,
          queued_at: Number(entry.queued_at) || 0,
        };
      }
    }
    const questions = parsed.questions;
    if (questions && typeof questions === "object" && !Array.isArray(questions)) {
      for (const [id, entry] of Object.entries(questions)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const patch = entry.patch && typeof entry.patch === "object" && !Array.isArray(entry.patch) ? entry.patch : null;
        if (!patch || !Object.keys(patch).length) continue;
        out.questions[String(id)] = {
          patch: { ...patch },
          updated_at: typeof entry.updated_at === "string" ? entry.updated_at : null,
          queued_at: Number(entry.queued_at) || 0,
        };
      }
    }
    return out;
  }
  function writePending(journal, storage) {
    const store = storageOf(storage);
    const next = emptyPending();
    for (const [id, entry] of Object.entries((journal && journal.annotations) || {})) {
      next.annotations[String(id)] = {
        markdown: String(entry.markdown == null ? "" : entry.markdown),
        updated_at: entry.updated_at || new Date().toISOString(),
        queued_at: Number(entry.queued_at) || Date.now(),
      };
    }
    for (const [id, entry] of Object.entries((journal && journal.questions) || {})) {
      const patch = { ...((entry && entry.patch) || {}) };
      if (!Object.keys(patch).length) continue;
      next.questions[String(id)] = { patch, updated_at: (entry && entry.updated_at) || new Date().toISOString(), queued_at: Number(entry && entry.queued_at) || Date.now() };
    }
    if (!store) return false;
    try {
      if (!Object.keys(next.annotations).length && !Object.keys(next.questions).length) {
        if (typeof store.removeItem === "function") store.removeItem(pendingKey);
        else store.setItem(pendingKey, "");
      } else {
        store.setItem(pendingKey, JSON.stringify(next));
      }
      return true;
    } catch { return false; }
  }
  function queueAnnotation(id, markdown, updatedAt, storage) {
    const journal = readPending(storage);
    journal.annotations[String(id)] = {
      markdown: String(markdown == null ? "" : markdown),
      updated_at: updatedAt || new Date().toISOString(),
      queued_at: Date.now(),
    };
    return writePending(journal, storage);
  }
  function queueQuestion(id, patch, storage) {
    const fields = Object.entries(patch || {}).filter(([, value]) => value !== undefined);
    if (!fields.length) return false;
    const key = String(id);
    const journal = readPending(storage);
    const merged = { ...((journal.questions[key] || {}).patch || {}) };
    for (const [field, value] of fields) merged[field] = value;
    journal.questions[key] = { patch: merged, updated_at: new Date().toISOString(), queued_at: Date.now() };
    return writePending(journal, storage);
  }
  // 服务端确认后才清除；若期间用户又改了（指纹不同）则保留待同步状态。
  function clearAnnotation(id, markdown, storage) {
    const key = String(id);
    const journal = readPending(storage);
    const entry = journal.annotations[key];
    if (!entry) return false;
    if (markdown !== undefined && entry.markdown !== markdown) return false;
    delete journal.annotations[key];
    return writePending(journal, storage);
  }
  function clearQuestion(id, patch, storage) {
    const key = String(id);
    const journal = readPending(storage);
    const entry = journal.questions[key];
    if (!entry) return false;
    const fields = patch && Object.keys(patch).length ? Object.keys(patch) : Object.keys(entry.patch);
    let changed = false;
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(entry.patch, field)) continue;
      // 只清除“已确认写服务端”的那个值；期间被改成别的值就继续挂着待同步
      if (patch && Object.prototype.hasOwnProperty.call(patch, field) && entry.patch[field] !== patch[field]) continue;
      delete entry.patch[field];
      changed = true;
    }
    if (!Object.keys(entry.patch).length) delete journal.questions[key];
    return changed ? writePending(journal, storage) : false;
  }
  function pendingHasAny(storage) {
    const journal = readPending(storage);
    return Object.keys(journal.annotations).length > 0 || Object.keys(journal.questions).length > 0;
  }
  root.DaguanPendingSync = {
    key: pendingKey,
    empty: emptyPending,
    read: readPending,
    write: writePending,
    queueAnnotation,
    queueQuestion,
    clearAnnotation,
    clearQuestion,
    annotationIds: storage => Object.keys(readPending(storage).annotations),
    questionIds: storage => Object.keys(readPending(storage).questions),
    hasAny: pendingHasAny,
  };

  // ---- 清除代次（服务端拥有 reset_generation；这里只做共享握手与本地清场） ----
  // 键名取自真实实现：恢复标记见 web/new-state.js；学习事件/恢复队列/备份缓存/会话见
  // web/study-activity-client.js；进度、收藏、批注、选题、学习位置与两版脚本共用。
  const progressResetKey = "daguan_progress_reset_generation_v1";
  const progressResetEvent = "daguan:progress-reset";
  const progressKey = "daguan_local_progress_v1";
  const favoritesKey = "daguan_local_favorites_v1";
  const positionKey = "daguan_learning_position_v2";
  const studyEventPrefix = "daguan_study_event_v1:";
  const studyRestorePrefix = "daguan_study_restore_v1:";
  const studyCacheKey = "daguan_study_backup_cache_v1";
  const studySessionsKey = "daguan_study_sessions_v1";
  const restorePendingKey = "daguan_restore_pending_v1";
  const restoreRollbackKey = "daguan_restore_rollback_v1";
  // 混合待同步队列里属于“旧练习”的字段要剥离，收藏意图与其时间戳必须留下。
  const favoritePatchFields = ["favorite", "is_favorite", "favorite_updated_at", "is_favorite_updated_at"];
  let confirmedGeneration = null;

  function resetFail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function progressStorage() {
    const store = storageOf(null);
    if (!store) throw resetFail("PROGRESS_RESET_STORAGE_UNAVAILABLE", "本地存储不可用，无法确认清除代次");
    return store;
  }
  function validGeneration(value) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }
  function generationOf(state) {
    if (!state || typeof state !== "object" || !Object.prototype.hasOwnProperty.call(state, "reset_generation") || state.reset_generation === undefined) return 0;
    const value = validGeneration(state.reset_generation);
    if (value === null) throw resetFail("PROGRESS_GENERATION_INVALID", "服务端清除代次无效，已停止处理");
    return value;
  }
  function stored() {
    const raw = progressStorage().getItem(progressResetKey);
    if (raw === null) return 0;
    const value = validGeneration(raw);
    if (value === null) throw resetFail("PROGRESS_RESET_STORAGE_CORRUPT", "本地清除代次戳损坏");
    return value;
  }
  function currentGeneration() { return confirmedGeneration; }
  function capture() {
    if (confirmedGeneration === null) throw resetFail("PROGRESS_GENERATION_UNKNOWN", "尚未确认清除代次，不能绑定学习请求");
    return confirmedGeneration;
  }
  function isCurrent(generation) {
    const value = validGeneration(generation);
    if (value === null || confirmedGeneration === null || value !== confirmedGeneration) return false;
    return stored() === value;
  }
  function removeStoredKey(store, key) {
    if (typeof store.removeItem !== "function") throw resetFail("PROGRESS_RESET_STORAGE_UNAVAILABLE", `本地存储不支持删除：${key}`);
    store.removeItem(key);
  }
  function keysWithPrefix(store, prefix) {
    const keys = [];
    const total = Number(store.length) || 0;
    for (let index = 0; index < total; index += 1) {
      const key = typeof store.key === "function" ? store.key(index) : null;
      if (typeof key === "string" && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }
  function storedProgress(store) {
    const raw = store.getItem(progressKey);
    if (raw === null) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { throw resetFail("PROGRESS_RESET_STORAGE_CORRUPT", "本地进度存储内容损坏，已停止清除以免丢失收藏"); }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  }
  function stripPendingPractice(store) {
    const journal = readPending(store);
    const ids = Object.keys(journal.questions);
    if (!ids.length) return;
    for (const id of ids) {
      const patch = {};
      for (const field of favoritePatchFields) {
        if (Object.prototype.hasOwnProperty.call(journal.questions[id].patch, field)) patch[field] = journal.questions[id].patch[field];
      }
      if (Object.keys(patch).length) journal.questions[id] = { ...journal.questions[id], patch };
      else delete journal.questions[id];
    }
    if (!Object.keys(journal.questions).length && !Object.keys(journal.annotations).length) {
      removeStoredKey(store, pendingKey);
      return;
    }
    store.setItem(pendingKey, JSON.stringify({ version: 1, annotations: journal.annotations, questions: journal.questions }));
  }
  function clearSessionPractice() {
    const session = root.sessionStorage;
    if (!session || typeof session.getItem !== "function") return;
    removeStoredKey(session, positionKey);
    removeStoredKey(session, studySessionsKey);
  }
  // 只清“旧练习”相关数据：收藏、批注、选题、备忘、AI、浏览历史与官网元数据都不在这里。
  function clearPracticeStorage(store, remoteState) {
    const previous = storedProgress(store);
    // 旧包裹形态把 favorites 放在 progress 里；先提取到独立收藏键，避免随后覆盖 progress 时丢掉收藏。
    if (store.getItem(favoritesKey) === null && previous && Array.isArray(previous.favorites)) {
      store.setItem(favoritesKey, JSON.stringify(previous.favorites.map(String)));
    }
    const remote = remoteState && remoteState.progress && typeof remoteState.progress === "object" && !Array.isArray(remoteState.progress) ? remoteState.progress : {};
    store.setItem(progressKey, JSON.stringify(remote));
    removeStoredKey(store, positionKey);
    clearSessionPractice();
    for (const key of keysWithPrefix(store, studyEventPrefix)) removeStoredKey(store, key);
    for (const key of keysWithPrefix(store, studyRestorePrefix)) removeStoredKey(store, key);
    removeStoredKey(store, studyCacheKey);
    removeStoredKey(store, restorePendingKey);
    removeStoredKey(store, restoreRollbackKey);
    stripPendingPractice(store);
  }
  function notifyProgressReset(detail) {
    root.dispatchEvent(new root.CustomEvent(progressResetEvent, { detail }));
  }
  // 事件派发能力必须在任何写操作之前确认：否则提交代次戳后才失败，下次会误判“已清”。
  function requireProgressResetEvent() {
    if (typeof root.dispatchEvent !== "function" || typeof root.CustomEvent !== "function") throw resetFail("PROGRESS_RESET_EVENT_UNAVAILABLE", "运行环境无法派发清除代次事件，已停止清除");
  }
  // 远端代次是权威值：不能倒退；持久戳落后才真正清storage，且代次戳最后提交。
  function adopt(remoteState) {
    const store = progressStorage();
    const generation = generationOf(remoteState);
    const persisted = stored();
    const known = confirmedGeneration;
    if (known !== null && generation < known) throw resetFail("STALE_PROGRESS_SNAPSHOT", `清除代次不能倒退（远端 ${generation}，已确认 ${known}）`);
    if (generation < persisted) throw resetFail("STALE_PROGRESS_SNAPSHOT", `清除代次不能倒退（远端 ${generation}，持久代次 ${persisted}）`);
    const baseline = known === null ? 0 : known;
    const changed = generation !== baseline;
    const storageChanged = generation !== persisted;
    if (changed || storageChanged) requireProgressResetEvent();
    if (storageChanged) {
      clearPracticeStorage(store, remoteState);
      store.setItem(progressResetKey, String(generation));
    } else if (changed) {
      // 别的窗口已把共享 localStorage 推进到新代次：只清本页 session 里的旧学习位置/会话。
      clearSessionPractice();
    }
    confirmedGeneration = generation;
    if (changed || storageChanged) notifyProgressReset({ generation, changed });
    return { generation, changed, storageChanged };
  }
  const progressReset = { generationOf, current: currentGeneration, stored, capture, isCurrent, adopt };

  const api = { selectionKey, appearanceKeys, appearanceInitKey, migrate, selected, targetUrl, draftKey, progressReset };
  root.DaguanVersions = api;
  if (!root.document) return;
  const current = root.location.pathname.endsWith("/legacy.html") ? "old" : "new";
  api.current = current;
  api.appearanceKey = appearanceKeys[current];
  try {
    migrate(root.localStorage);
    if (current === "old") {
      root.localStorage.setItem(selectionKey, "old");
    } else if (new URL(root.location.href).searchParams.get("ui") === "new") {
      // 显式 ?ui=new 优先于持久旧版偏好：写回 new 且不跳转，保证启动器进入新版。
      root.localStorage.setItem(selectionKey, "new");
    } else if (selected(root.localStorage) === "old") {
      root.location.replace(targetUrl(root.location.href, "old"));
    }
  } catch { /* Restricted storage must not prevent reading the question bank. */ }
  root.document.documentElement.dataset.uiVersion = current;
})(typeof window === "undefined" ? globalThis : window);

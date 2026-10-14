(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const READONLY_HINT = '远程会话为只读：AI 服务配置请在本机修改，可继续选择服务问答。';
  const STORAGE_LABELS = { dpapi: 'Windows DPAPI 加密', memory: '进程内存密钥（不持久化）', none: '未启用加密', test: '测试后端', custom: '自定义后端' };
  // keyStatus: ok | none | unmigrated（旧明文待迁移）| unreadable（本机无法解密）。
  const keyBroken = profile => profile?.keyStatus === 'unreadable' || profile?.keyStatus === 'unmigrated';
  // /api/runtime 的 aiConfig 只读标志：远程会话 writable=false，前端真正禁用配置操作。
  let aiConfig = null, aiConfigPromise = null;
  function loadAiConfig(force = false) {
    if (!aiConfigPromise || force) {
      aiConfigPromise = request('./api/runtime')
        .then(data => { aiConfig = data?.aiConfig || null; return aiConfig; })
        .catch(() => { aiConfig = null; return null; });
    }
    return aiConfigPromise;
  }
  const readOnly = () => aiConfig?.writable === false;
  const hasSavedKey = profile => profile?.hasKey === true || Boolean(profile?.keyHint && profile.keyHint !== '未设置');
  async function request(url, method = 'GET', body) {
    let response;
    try { response = await fetch(url, { method, cache: 'no-store', headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new Error('无法连接本地服务，请检查服务是否仍在运行'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
    return data;
  }
  function mount(host, hooks) {
    if (!host) return;
    if (host.aiSettings) { host.aiSettings.refresh(); return host.aiSettings; }
    host.classList.add('ai-services');
    host.innerHTML = `<div class="ai-settings-heading"><h3>AI 服务</h3><button type="button" class="btn btn-primary primary" data-config="1" data-action="new">新增服务</button></div>
      <p>支持 OpenAI 兼容接口。Key 只保存在本地服务中。<small data-storage></small></p><div data-list></div>
      <form data-editor hidden><h4 data-title>新增服务</h4><div class="ai-services-fields">
      <label>名称<input name="name" data-config="1" required placeholder="例如：我的中转服务"></label>
      <label>API 基地址<input name="baseUrl" data-config="1" type="url" required placeholder="https://api.example.com/v1"></label>
      <small data-endpoint></small>
      <label>API Key <small data-key-status></small><input name="key" data-config="1" type="password" autocomplete="new-password" placeholder="编辑时留空沿用已保存的 Key"></label>
      <label class="ai-services-check" data-clear-key hidden><input name="clearKey" data-config="1" type="checkbox">同时清除已保存的 Key</label>
      <label>模型<input name="model" data-config="1" list="ai-service-model-options" placeholder="搜索模型列表或手填模型名"><datalist id="ai-service-model-options"></datalist></label>
      <label class="ai-services-check"><input name="streaming" data-config="1" type="checkbox" checked>流式回答</label></div>
      <div class="ai-services-actions"><button type="submit" class="btn btn-primary primary" data-config="1">保存服务</button><button type="button" class="btn" data-config="1" data-action="models">获取模型列表</button><button type="button" class="btn" data-config="1" data-action="text">文本连接测试</button><button type="button" class="btn" data-config="1" data-action="vision">图片能力测试</button><button type="button" class="btn" data-action="cancel">取消</button></div></form>
      <p data-status role="status" aria-live="polite"></p>`;
    const form = host.querySelector('form');
    const field = name => form.elements.namedItem(name);
    const status = host.querySelector('[data-status]');
    const keyStatus = () => host.querySelector('[data-key-status]');
    let profiles = [], editingId = '', saved = '', savedBaseUrl = '', working = false;
    const fingerprint = () => JSON.stringify(['name','baseUrl','model','key'].map(name => field(name).value).concat(field('streaming').checked, field('clearKey')?.checked === true));
    const busy = () => hooks.busy() || working;
    const updateEndpoint = () => { host.querySelector('[data-endpoint]').textContent = field('baseUrl').value.trim() ? `请求地址：${field('baseUrl').value.trim().replace(/\/+$/, '')}/chat/completions` : ''; };
    const currentProfile = () => profiles.find(item => item.id === editingId) || null;
    const updateKeyHint = profile => {
      const node = keyStatus(); if (!node) return;
      const target = profile || currentProfile();
      let text = '未设置', tone = '';
      if (keyBroken(target)) { text = target.keyStatus === 'unmigrated' ? '旧版明文 Key 待迁移，请重新填写并保存' : '本机解密失败，请重新填写 Key'; tone = 'warn'; }
      else if (hasSavedKey(target)) {
        text = '已保存；留空沿用';
        if (editingId && target && savedBaseUrl && field('baseUrl').value.trim() && field('baseUrl').value.trim() !== savedBaseUrl) { text = '基地址已更改：请重新填写 API Key'; tone = 'warn'; }
      }
      node.textContent = text;
      node.dataset.tone = tone;
      const clearKey = host.querySelector('[data-clear-key]');
      if (clearKey) clearKey.hidden = !(editingId && hasSavedKey(target));
    };
    const renderStorage = () => {
      const node = host.querySelector('[data-storage]'); if (!node) return;
      if (!aiConfig) { node.textContent = ''; return; }
      const label = STORAGE_LABELS[aiConfig.backend] || aiConfig.backend || '本机文件';
      const notes = [];
      if (aiConfig.encrypted === false) notes.push('当前未加密');
      if (aiConfig.available === false) notes.push('加密后端不可用');
      if (readOnly()) notes.push('远程只读');
      node.textContent = `Key 存储：${label}${notes.length ? `（${notes.join('；')}）` : ''}`;
    };
    const renderList = () => {
      host.querySelector('[data-list]').innerHTML = profiles.length ? profiles.map(p => `<div class="ai-service-item"><div><strong>${escape(p.name)}</strong><small>${escape(p.model || '未选择模型')} · ${hasSavedKey(p) ? 'Key 已保存' : '未设置 Key'}${keyBroken(p) ? '（需重新填写）' : ''} · ${p.streaming === false ? '非流式' : '流式'} · ${p.capabilities?.text ? '文本已验证' : '文本未验证'} · ${p.capabilities?.vision === 'passed' ? '图片已验证' : '图片未验证'}${p.id === hooks.selectedId() ? ' · 当前使用' : ''}</small></div><div><button type="button" class="btn" data-config="1" data-edit="${escape(p.id)}">编辑</button><button type="button" class="btn" data-use="${escape(p.id)}">使用</button><button type="button" class="btn" data-config="1" data-delete="${escape(p.id)}">删除</button></div></div>`).join('') : '<p>还没有 AI 服务，点击“新增服务”开始配置。</p>';
      syncBusy();
    };
    const syncBusy = () => host.querySelectorAll('button, input').forEach(el => { el.disabled = busy() || (readOnly() && el.dataset.config === '1'); });
    const refresh = async () => {
      try { profiles = (await request('./api/ai/profiles')).profiles || []; hooks.changed(profiles); renderList(); }
      catch (error) { status.textContent = error.message; }
    };
    const open = id => {
      if (readOnly()) { status.textContent = READONLY_HINT; return; }
      const p = profiles.find(item => item.id === id);
      editingId = p?.id || ''; form.hidden = false;
      host.querySelector('[data-title]').textContent = p ? '编辑服务' : '新增服务';
      ['name','baseUrl','model'].forEach(name => { field(name).value = p?.[name] || ''; });
      field('key').value = ''; field('streaming').checked = p?.streaming !== false;
      field('clearKey').checked = false;
      savedBaseUrl = p?.baseUrl || '';
      updateKeyHint(p);
      host.querySelector('datalist').innerHTML = ''; status.textContent = ''; updateEndpoint(); saved = fingerprint(); field('name').focus();
    };
    const dirty = () => !form.hidden && fingerprint() !== saved;
    const canLeave = () => !dirty() || confirm('还有未保存的服务配置，是否放弃这些修改？');
    const action = async fn => {
      if (busy() || readOnly() || !hooks.allowed()) return;
      working = true; syncBusy();
      try { await fn(); } catch (error) { status.textContent = error.message; }
      finally { working = false; syncBusy(); }
    };
    form.addEventListener('input', () => { updateEndpoint(); updateKeyHint(); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (readOnly()) { status.textContent = READONLY_HINT; return; }
      action(async () => {
        const body = Object.fromEntries(['name','baseUrl','model','key'].map(name => [name, field(name).value.trim()])); body.streaming = field('streaming').checked;
        body.clearKey = field('clearKey').checked === true;
        const data = await request(editingId ? `./api/ai/profiles/${encodeURIComponent(editingId)}` : './api/ai/profiles', editingId ? 'PATCH' : 'POST', body);
        const savedProfile = data.profile || {};
        editingId = savedProfile.id || editingId; field('key').value = ''; saved = fingerprint(); savedBaseUrl = savedProfile.baseUrl || '';
        field('clearKey').checked = false;
        host.querySelector('[data-title]').textContent = '编辑服务';
        updateKeyHint(savedProfile);
        await refresh(); hooks.select(editingId); renderList();
        if (savedProfile.keyCleared === true) {
          status.textContent = `服务已保存，但旧 Key 已清除：请重新填写 API Key 并再次保存。${savedProfile.warning ? `（${savedProfile.warning}）` : ''}`;
        } else if (savedProfile.warning) {
          status.textContent = `服务已保存。${savedProfile.warning}`;
        } else if (keyBroken(savedProfile)) {
          status.textContent = '服务已保存，但 Key 无法解密：请重新填写 API Key 并再次保存。';
        } else {
          status.textContent = '服务已保存。可以获取模型列表或测试连接。';
        }
      });
    });
    host.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.type === 'submit' || busy()) return;
      const configControl = button.dataset.config === '1';
      if (configControl && readOnly()) { status.textContent = READONLY_HINT; return; }
      if (!hooks.allowed()) return;
      if (button.dataset.edit !== undefined) { if (canLeave()) open(button.dataset.edit); return; }
      if (button.dataset.use !== undefined) { if (!canLeave()) return; form.hidden = true; hooks.select(button.dataset.use); renderList(); status.textContent = '已切换服务'; return; }
      if (button.dataset.delete !== undefined) {
        if (!canLeave() || !confirm('删除这个服务？聊天历史将保留。')) return;
        action(async () => { await request(`./api/ai/profiles/${encodeURIComponent(button.dataset.delete)}`, 'DELETE', {clearHistory:false}); if (editingId === button.dataset.delete) form.hidden = true; await refresh(); if (!profiles.some(p => p.id === hooks.selectedId())) hooks.select(profiles[0]?.id || ''); renderList(); status.textContent = '服务已删除，聊天历史已保留'; }); return;
      }
      const kind = button.dataset.action;
      if (kind === 'new') { if (canLeave()) open(''); return; }
      if (kind === 'cancel') { if (canLeave()) form.hidden = true; return; }
      if (!editingId || dirty()) { status.textContent = '请先保存当前配置，再获取模型或测试。'; return; }
      action(async () => {
        status.textContent = kind === 'models' ? '正在获取模型列表…' : '正在测试…';
        const url = `./api/ai/profiles/${encodeURIComponent(editingId)}/${kind === 'models' ? 'models' : 'test'}`;
        const data = await request(url, kind === 'models' ? 'GET' : 'POST', kind === 'models' ? undefined : {kind});
        if (kind === 'models') {
          host.querySelector('datalist').innerHTML = (data.models || []).map(model => `<option value="${escape(model)}"></option>`).join('');
          status.textContent = data.models?.length ? `已获取 ${data.models.length} 个模型。点击模型输入框搜索或手动填写，选择后保存。` : '接口未返回模型列表，请手动填写模型名。'; field('model').focus();
        } else { status.textContent = `${kind === 'vision' ? '图片能力' : '文本连接'}测试通过 · HTTP ${data.status} · ${data.latencyMs}ms · ${data.response || '无摘要'}`; await refresh(); }
      });
    });
    host.aiSettings = {refresh, syncBusy};
    void loadAiConfig().then(() => { renderStorage(); syncBusy(); });
    refresh(); return host.aiSettings;
  }
  function bindStreaming(input, hooks) {
    if (!input) return;
    input.checked = hooks.profile()?.streaming !== false;
    input.dataset.aiServiceControl = 'true';
    const syncDisabled = () => { input.disabled = hooks.busy() || readOnly(); };
    void loadAiConfig().then(syncDisabled);
    input.addEventListener('change', async () => {
      const profile = hooks.profile(); const previous = profile?.streaming !== false;
      if (readOnly()) { input.checked = previous; hooks.error(READONLY_HINT); return; }
      if (!profile || hooks.busy() || !hooks.allowed()) { input.checked = previous; return; }
      input.disabled = true;
      try { const data = await request(`./api/ai/profiles/${encodeURIComponent(profile.id)}`, 'PATCH', {streaming:input.checked}); hooks.changed(data.profile); }
      catch (error) { input.checked = previous; hooks.error(error.message); }
      finally { syncDisabled(); }
    });
  }
  window.DaguanAISettings = {mount, bindStreaming};
})();

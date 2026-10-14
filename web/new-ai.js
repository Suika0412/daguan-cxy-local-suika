(function(root) {
"use strict";
root.DaguanNewAI = { create({ window, document, fetch, location, AppState, StorageService, assetUrl, escapeHtml, renderMarkdown, toast, getAccess, getRenderer, getApp }) {
const AI_COMPOSE_PROMPTS = {
    brief: '请简短回答：先用一句话给出核心结论，再用 2～4 句话说明最关键的一步是怎么来的。只保留考研解题真正需要的内容，不展开完整推导、不重复题干；公式只留最关键的一个，较长公式单独成行。最后可以用一句话点出这道题在考研里属于哪类常考题型。',
    detailed: '请详细回答这道题，按考研复习的标准展开：## 答案、## 考研视角、## 详细推导、## 得分点与易错点。其中「考研视角」要说明这道题在考研大纲里对应什么知识点、要求到什么层次（了解／理解／掌握）、属于哪类常考题型、卷面上是选择/填空还是解答题以及大致分值。「详细推导」中每一步都要说明本步目标、知识点及其具体定义或公式、适用条件、从题干或前一步哪条信息想到该方法、推导过程与结果。清楚区分题干直接信息、前一步推出的结论和官方解析提供的信息，不能把题干没有给出的信息说成已知。数学公式使用 LaTeX，较长公式单独成行。',
    full: '请从考研复习的角度给出这道题的完整解答，按以下 Markdown 标题组织：## 答案、## 简短思路、## 详细推导、## 方法与易错点。先明确给出答案，再用简短段落说明解题路线，随后保留详细教学过程。每个关键步骤都应说明本步目标、知识点及其具体定义或公式、适用条件、从哪些题干或前一步信息想到该方法、推导过程与结果；把这些依据自然融入步骤，不机械重复七项标签，不把关键推理合并成一句话。清楚区分题干直接信息、前一步推出的结论和官方解析提供的信息，不能将题干没有给出的信息说成已知。最后总结识别这类题的信息、通用方法和必要的易错提醒，避免重复前文。选择题逐项解释关键判断理由。数学公式使用 LaTeX，较长公式单独成行。',
    hint: '先不要直接跳到结论，给我一个解题提示。',
    pitfall: '请指出这道题最容易犯的错误。'
};

// 图片附件契约（与本地中控台一致）：PNG/JPEG/WebP/GIF dataURL；用户附件 ≤4 张、单张原文件 ≤2MiB；
// 整个请求 JSON 的 UTF-8 字节数必须 ≤10MiB。不压缩、不提高服务端上限。
const AI_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const AI_IMAGE_LIMIT = 4;
const AI_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const AI_REQUEST_MAX_BYTES = 10 * 1024 * 1024;
const AI_IMAGE_ONLY_PROMPT = '请结合图片回答我的问题。';

function utf8ByteLength(text) {
    return new TextEncoder().encode(String(text ?? '')).length;
}

// 当前题面板内存里的轻量附件状态：不持久化，不写入草稿/历史。
class AIAttachments {
    constructor() {
        this.questionId = '';
        this.panel = null;
        this.items = [];
        this.reading = 0;
        this.imageSeq = 0;
        // 批次有效期：换题、面板重渲染、重置都会 +1，作废所有在途读取。
        this.generation = 0;
    }

    static allowed(mime) { return AI_IMAGE_TYPES.includes(String(mime || '').toLowerCase()); }

    // 作废在途批次：旧批次的结果必须丢弃，且不得改动新题的占位数。
    invalidate() {
        this.generation += 1;
        this.reading = 0;
    }

    // 附件只属于当前题：题号变化即丢弃上一题附件，异步读取结果也不会再匹配。
    forQuestion(questionId) {
        const id = String(questionId ?? '');
        if (this.questionId !== id) {
            this.questionId = id;
            this.invalidate();
            this.items = [];
            this.render();
        }
        return this;
    }

    reset() {
        this.questionId = '';
        this.invalidate();
        this.items = [];
        this.render();
    }

    // 只清空附件，保留当前题归属：发送成功后输入区仍属于同一题。
    clear() {
        this.items = [];
        this.render();
    }

    dataUrls() { return this.items.map(item => item.dataUrl); }

    snapshot() { return { images: this.dataUrls(), names: this.items.map(item => item.name) }; }

    // 失败重试恢复：快照整体替换附件，并作废在途批次，避免旧读取覆盖恢复结果。
    restore(snapshot) {
        const images = Array.isArray(snapshot?.images) ? snapshot.images : [];
        const names = Array.isArray(snapshot?.names) ? snapshot.names : [];
        this.invalidate();
        this.items = images.map((dataUrl, index) => ({
            id: `ai-image-${++this.imageSeq}`,
            name: names[index] || `图片 ${index + 1}`,
            dataUrl,
        }));
        this.render();
    }

    remove(id) {
        if (AppState.aiBusy) { toast('AI 正在生成，暂时不能更改附件'); return; }
        const index = this.items.findIndex(item => item.id === id);
        if (index < 0) return;
        this.items.splice(index, 1);
        this.render();
    }

    // 整批占位、整批校验：名额不足则拒绝整批并保留原附件，不截断用户选择。
    async addFiles(fileList) {
        const files = Array.from(fileList || []).filter(Boolean);
        if (!files.length) return;
        if (AppState.aiBusy) { toast('AI 正在生成，暂时不能更改附件'); return; }
        const room = AI_IMAGE_LIMIT - this.items.length - this.reading;
        if (files.length > room) {
            toast(room <= 0
                ? `最多只能添加 ${AI_IMAGE_LIMIT} 张图片`
                : `本次选了 ${files.length} 张，剩余名额只有 ${room} 张，请减少后再添加`);
            return;
        }
        // 格式与单图大小先整批校验：任一项不合法就拒绝整批，不影响已有附件和占位。
        for (const file of files) {
            const name = String(file.name || '未知文件');
            if (!AIAttachments.allowed(file.type)) { toast(`不支持的图片格式：${name}`); return; }
            if (Number(file.size) > AI_IMAGE_MAX_BYTES) { toast(`图片超过 2MiB：${name}`); return; }
        }
        const generation = this.generation;
        const questionId = this.questionId;
        const panel = this.panel;
        this.reading += files.length;
        this.render();
        for (const file of files) {
            const name = String(file.name || '未知文件');
            let dataUrl = null;
            try {
                dataUrl = await this.readFile(file);
            } catch (error) {
                if (this.isCurrentBatch(generation, questionId, panel)) toast(`图片读取失败：${name}（${error.message || '未知错误'}）`);
            }
            // 过期批次：不写入结果，也不改动新题的占位数。
            if (!this.isCurrentBatch(generation, questionId, panel)) return;
            this.reading -= 1;
            if (dataUrl) this.items.push({ id: `ai-image-${++this.imageSeq}`, name, dataUrl });
            this.render();
        }
    }

    isCurrentBatch(generation, questionId, panel) {
        return this.generation === generation && this.questionId === questionId && this.panel === panel;
    }

    readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result;
                if (typeof result === 'string' && result) resolve(result);
                else reject(new Error('读取结果为空'));
            };
            reader.onerror = () => reject(new Error('无法读取文件'));
            reader.readAsDataURL(file);
        });
    }

    bindPanel(panel, question) {
        this.panel = panel;
        this.forQuestion(question?.id);
        // 输入区每次重建都作废在途批次：旧读取不得写进新面板（renderAIPanel 复用同一节点重建 innerHTML）。
        this.invalidate();
        this.render();
        const fileInput = panel.querySelector('#ai-attach-input');
        panel.querySelector('#ai-attach-btn')?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', () => {
            // fileInput.files 是 live FileList：必须先快照，再清空 input，否则 addFiles 会拿到空列表。
            const files = Array.from(fileInput.files || []);
            fileInput.value = '';
            this.addFiles(files);
        });
        // 只截获剪贴板里的图片；普通文本粘贴保持原行为，不做文件内容嗅探。
        panel.querySelector('#ai-input')?.addEventListener('paste', event => {
            const items = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file');
            if (!items.length) return;
            // 剪贴板里有文件时不再放行默认粘贴：不支持的图片格式要明确提示，不能静默丢掉内容。
            event.preventDefault();
            const unsupported = items.filter(item => !AIAttachments.allowed(item.type));
            if (unsupported.length) toast(`不支持的图片格式：${unsupported.map(item => item.type || '未知类型').join('、')}`);
            this.addFiles(items.filter(item => AIAttachments.allowed(item.type)).map(item => item.getAsFile()));
        });
        const dropZone = panel.querySelector('.ai-input-area');
        dropZone?.addEventListener('dragover', event => {
            if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
        });
        dropZone?.addEventListener('drop', event => {
            const files = Array.from(event.dataTransfer?.files || []);
            if (!files.length) return;
            event.preventDefault();
            this.addFiles(files);
        });
        this.render();
    }

    render() {
        const host = this.panel?.querySelector?.('#ai-attachment-previews');
        if (host) {
            host.replaceChildren();
            host.hidden = !this.items.length && !this.reading;
            for (const item of this.items) {
                const card = document.createElement('div');
                card.className = 'ai-attachment';
                const preview = document.createElement('img');
                preview.src = item.dataUrl;
                preview.alt = item.name;
                const name = document.createElement('span');
                name.className = 'ai-attachment-name';
                name.textContent = item.name;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'ai-attachment-remove';
                remove.textContent = '×';
                remove.setAttribute('aria-label', `移除图片 ${item.name}`);
                remove.addEventListener('click', () => this.remove(item.id));
                card.append(preview, name, remove);
                host.appendChild(card);
            }
            for (let index = 0; index < this.reading; index += 1) {
                const pending = document.createElement('div');
                pending.className = 'ai-attachment ai-attachment-reading';
                pending.textContent = '正在读取图片…';
                host.appendChild(pending);
            }
        }
        this.syncSendState();
    }

    syncSendState() {
        const send = document.getElementById('ai-send-btn');
        if (send) send.disabled = AppState.aiBusy || this.reading > 0;
    }
}

const AIAttachmentsState = new AIAttachments();

class AIService {
    // SSE 跨块解析：不完整的行保留到下一块；返回 {events, rest}
    static parseSseChunk(buffer, text) {
        let working = String(buffer || '') + String(text || '');
        const events = [];
        const rows = working.split(/\r?\n/);
        const rest = rows.pop() || '';
        for (const row of rows) {
            if (!row.startsWith('data:')) continue;
            const data = row.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try { events.push(JSON.parse(data)); } catch { /* 忽略 keep-alive 碎片 */ }
        }
        return { events, rest };
    }

    static async loadProfiles() {
        try {
            const response = await fetch('./api/ai/profiles', { cache: 'no-store' });
            const data = await response.json();
            AppState.aiProfiles = Array.isArray(data.profiles) ? data.profiles : [];
        } catch {
            AppState.aiProfiles = [];
        }
        const preferred = StorageService.getAIPreferences().profileId;
        AppState.aiProfileId = AppState.aiProfiles.find(item => item.id === preferred)?.id
            || AppState.aiProfiles.find(item => item.active)?.id
            || AppState.aiProfiles[0]?.id
            || '';
        return AppState.aiProfiles;
    }

    static activeProfile() {
        return AppState.aiProfiles?.find(item => item.id === AppState.aiProfileId) || null;
    }

    static selectProfile(profileId) {
        AppState.aiProfileId = profileId || '';
        StorageService.saveAIPreference('profileId', AppState.aiProfileId);
    }

    // 服务端固定 system 指令负责数学教学约束；客户端只送 prompt + 题目载荷。
    static chatBody({ question, prompt, includePrivate = false, images = [] }) {
        return {
            profileId: AppState.aiProfileId,
            question: this.questionPayload(question),
            prompt: String(prompt || ''),
            includePrivate: includePrivate === true,
            images: Array.isArray(images) ? images : [],
        };
    }

    // 请求体上限与本地中控台一致：整个 JSON 的 UTF-8 字节数不得超过 10MiB。
    static assertBodySize(body) {
        const size = utf8ByteLength(JSON.stringify(body));
        if (size > AI_REQUEST_MAX_BYTES) {
            throw new Error(`本次请求约 ${(size / 1024 / 1024).toFixed(1)}MiB，超过 10MiB 上限，请减少或换用更小的图片`);
        }
        return size;
    }

    static async chatStream({ question, prompt, includePrivate = false, images = [], signal }) {
        if (!AppState.aiProfileId) throw new Error('请先在设置中选择或配置 AI 服务');
        const body = this.chatBody({ question, prompt, includePrivate, images });
        const response = await fetch('./api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `AI 请求失败（HTTP ${response.status}）`);
        }
        return response;
    }

    static async stopRun(runId) {
        if (!runId) return;
        await fetch(`./api/ai/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }).catch(() => {});
    }

    static questionPayload(q) {
        const progress = StorageService.getProgress().progress[String(q?.id)] || {};
        const annotation = StorageService.getAnnotation(q?.id).content || '';
        return {
            id: q?.id,
            category_path: q?.category_path || getRenderer().chapterLabel?.(q) || '',
            source: q?.source || '',
            type: q?.type || '',
            stem: q?.stem || q?.question || '',
            options: q?.options || [],
            answer: q?.answer || '',
            explanation: q?.explanation || '',
            userAnswer: AppState.answers?.[String(q?.id)] ? [...AppState.answers[String(q?.id)]].join(', ') : '',
            annotation,
            mastery: progress.mastery || 'not_started',
            errorProne: progress.error_prone === true,
            favorite: StorageService.isFavorite(q?.id),
        };
    }

    // 视觉档案才附带题目图片（每张 ≤2MB，dataURL）；默认最多 4 张，用户附件占用名额时只补剩余张数。
    static async questionImages(q, limit = AI_IMAGE_LIMIT) {
        if (!q) return [];
        const room = Math.max(0, Math.min(AI_IMAGE_LIMIT, Number(limit) || 0));
        if (!room) return [];
        const source = `${q.stem || q.question || ''}\n${(q.options || []).map(o => o.content_md || '').join('\n')}\n${q.answer || ''}\n${q.explanation || ''}`;
        const refs = [...source.matchAll(/!\[[^\]]*\]\(([^)]+)\)|<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1] || m[2]).filter(Boolean).slice(0, room);
        const out = [];
        for (const ref of refs) {
            try {
                const response = await fetch(new URL(assetUrl(ref), location.href));
                if (!response.ok) continue;
                const blob = await response.blob();
                if (blob.size > AI_IMAGE_MAX_BYTES) continue;
                const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(''); reader.readAsDataURL(blob); });
                if (data) out.push(data);
            } catch {}
        }
        return out;
    }

    // 按题隔离的聊天历史（保存在本地中控台，按 profile+question 分键）
    static async loadHistory(question) {
        if (!question || !AppState.aiProfileId) return [];
        try {
            const response = await fetch(`./api/ai/conversations/${encodeURIComponent(AppState.aiProfileId)}/${encodeURIComponent(String(question.id))}`, { cache: 'no-store' });
            if (!response.ok) return [];
            const data = await response.json();
            return Array.isArray(data.messages) ? data.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant')) : [];
        } catch { return []; }
    }
}


class AIViews {
    static captureAIPanel() {
        const panel = document.getElementById('ai-panel');
        return { panel, scrollTop: panel?.querySelector?.('#ai-messages')?.scrollTop || 0 };
    }

    static restoreAIPanel(snapshot, question) {
        const panel = snapshot.panel;
        if (!panel?.dataset?.questionId || panel.dataset.questionId !== String(question?.id)) return false;
        const placeholder = document.getElementById('ai-panel');
        if (!placeholder || placeholder === panel) return false;
        placeholder.replaceWith(panel);
        panel.classList.toggle('closed', !AppState.ui.aiPanelOpen);
        panel.querySelector('#ai-messages').scrollTop = snapshot.scrollTop;
        window.DaguanAIPanelLayout?.update();
        return true;
    }

    static renderAIPanel() {
        const panel = document.getElementById('ai-panel');
        if (!panel) return;
        if (AppState.ui.aiPanelOpen) panel.classList.remove('closed');

        const question = AppState.questions[AppState.currentQuestionIndex];
        panel.dataset.questionId = String(question?.id || '');
        const draft = question ? StorageService.getAIDraft(question.id) : '';
        const profiles = AppState.aiProfiles || [];
        const profileOptions = profiles.length
            ? profiles.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === AppState.aiProfileId ? 'selected' : ''}>${escapeHtml(item.name)}${item.model ? ` · ${escapeHtml(item.model)}` : ''}</option>`).join('')
            : '<option value="">未配置 AI</option>';

        panel.innerHTML = `
            <div class="ai-panel-resize" role="separator" tabindex="0" aria-label="调整 AI 面板宽度" aria-orientation="vertical"></div>
            <div class="ai-header">
                <h3>AI 辅助</h3>
                <div class="ai-header-actions">
                <button type="button" class="btn btn-text btn-sm" id="ai-expand-btn" aria-pressed="false">展开</button>
                <button type="button" class="btn btn-text btn-sm" id="ai-settings-btn" aria-expanded="false" aria-controls="ai-panel-settings">设置</button>
                <button class="btn btn-icon btn-text" onclick="App.toggleAI()" aria-label="关闭 AI 面板">
                    <svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
                </div>
            </div>
            <div class="ai-panel-settings" id="ai-panel-settings" hidden role="region" aria-label="AI 设置">
            <div class="ai-profile-row">
                <label for="ai-profile-select-new">服务</label>
                <select data-ai-service-control="true" id="ai-profile-select-new" onchange="App.selectAIProfile(this.value)">${profileOptions}</select>
                <button type="button" class="btn btn-text btn-sm" onclick="App.navigate('settings')">设置</button>
            </div>

            <label class="ai-streaming-control"><input type="checkbox" id="ai-streaming-new"> 流式回答</label>
            <label class="ai-privacy-check"><input type="checkbox" id="ai-include-private-new"> 包含我的批注与学习状态</label>
            </div>
            <p class="ai-private-status" id="ai-private-status" hidden>已包含批注与学习状态</p>
            <div class="ai-quick-prompts">
                <button class="quick-prompt-btn" onclick="App.sendAIPrompt(AI_COMPOSE_PROMPTS.brief)">简短回答</button>
                <button class="quick-prompt-btn" onclick="App.sendAIPrompt(AI_COMPOSE_PROMPTS.detailed)">详细回答</button>
                <button class="quick-prompt-btn" onclick="App.sendAIPrompt(AI_COMPOSE_PROMPTS.full)">完整解答</button>
                <button class="quick-prompt-btn" onclick="App.sendAIPrompt(AI_COMPOSE_PROMPTS.hint)">给我提示</button>
                <button class="quick-prompt-btn" onclick="App.sendAIPrompt(AI_COMPOSE_PROMPTS.pitfall)">易错点</button>
                <p class="ai-quick-hint">回答里的每一段都能点：点一下就能追问「这个是怎么来的 / 什么意思 / 什么知识点 / 你有什么想法」。</p>
            </div>

            <nav class="ai-section-nav" id="ai-section-nav" aria-label="回答段落跳转" hidden></nav>
            <div class="ai-messages" id="ai-messages"><div class="ai-empty"><strong>先问一个问题</strong><p>题目上下文已经准备好，选择上方提示或直接输入你的疑问。</p></div></div>
            <div class="ai-reading-actions"><button type="button" class="btn btn-secondary btn-sm" id="ai-latest-btn" hidden>回到最新内容</button></div>

            <div class="ai-input-area">
                <div class="ai-input-wrapper">
                    <div class="ai-input-column">
                        <div class="ai-attachment-previews" id="ai-attachment-previews" hidden></div>
                        <textarea class="ai-input" id="ai-input"
                            placeholder="输入你的问题..."
                            rows="1">${escapeHtml(draft)}</textarea>
                    </div>
                    <div class="ai-input-actions">
                        <span class="ai-input-buttons">
                            <button type="button" class="btn btn-secondary btn-sm" id="ai-attach-btn" aria-label="添加图片">图片</button>
                            <input type="file" id="ai-attach-input" class="ai-attach-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
                            <button type="button" class="btn btn-secondary btn-sm" id="ai-stop-btn" hidden onclick="App.stopAIStream()">停止</button>
                            <button class="btn btn-primary ai-send-btn" id="ai-send-btn" onclick="App.sendAIMessage()">发送</button>
                        </span>
                    </div>
                </div>
            </div>
        `;

        window.DaguanAIReading?.bind(panel);
        window.DaguanAIPanelLayout?.bind(panel);
        window.DaguanAISettings?.bindStreaming(document.getElementById('ai-streaming-new'), {
            profile: () => AIService.activeProfile(), busy: () => AppState.aiBusy,
            allowed: () => getAccess().privateAllowed(), error: message => toast(message),
            changed: profile => { Object.assign(AIService.activeProfile() || {}, profile); },
        });
        document.getElementById('ai-profile-select-new').disabled = AppState.aiBusy;
        const input = document.getElementById('ai-input');
        if (input) {
            input.addEventListener('input', () => {
                if (question) StorageService.saveAIDraft(question.id, input.value);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); getApp().sendAIMessage(); }
            });
        }
        AIAttachmentsState.bindPanel(panel, question);
        getApp().aiBusyUi(AppState.aiBusy);
        if (question) this.renderAIHistory(question);
    }

    static async renderAIHistory(question) {
        const messagesEl = document.getElementById('ai-messages');
        if (!messagesEl || !question) return;
        const profileId = AppState.aiProfileId;
        const history = await AIService.loadHistory(question);
        // 用户可能已切题，历史回来时校验仍是当前题
        const current = AppState.questions[AppState.currentQuestionIndex];
        if (!current || String(current.id) !== String(question.id) || profileId !== AppState.aiProfileId ||
            messagesEl !== document.getElementById('ai-messages') || AppState.aiBusy) return;
        if (!history.length) return;
        messagesEl.innerHTML = '';
        for (const message of history) {
            const msg = document.createElement('div');
            msg.className = `ai-message ${message.role === 'user' ? 'user' : 'assistant'}`;
            msg.innerHTML = `<div class="ai-message-bubble">${message.role === 'user' ? escapeHtml(message.content) : renderMarkdown(message.content)}</div>`;
            messagesEl.appendChild(msg);
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
        window.DaguanAIReading?.refreshSections();
        window.DaguanAIReading?.toLatest();
    }

}
class AIController {
    static async sendAIPrompt(prompt) {
        const input = document.getElementById('ai-input');
        if (input) input.value = prompt;
        await this.sendAIMessage();
    }

    static selectAIProfile(profileId) {
        if (AppState.aiBusy) return;
        AIService.selectProfile(profileId);
        const stream = document.getElementById('ai-streaming-new');
        if (stream) stream.checked = AIService.activeProfile()?.streaming !== false;
        const question = AppState.questions[AppState.currentQuestionIndex];
        if (question) getRenderer().renderAIHistory(question);
    }

    static aiBusyUi(busy) {
        AppState.aiBusy = busy;
        document.querySelectorAll('[data-ai-service-control]').forEach(el => { el.disabled = busy; });
        document.getElementById('ai-services-settings')?.aiSettings?.syncBusy();
        const stop = document.getElementById('ai-stop-btn');
        const send = document.getElementById('ai-send-btn');
        if (stop) stop.hidden = !busy;
        AIAttachmentsState.syncSendState();
        window.DaguanAIReading?.fitInput();
    }

    static async stopAIStream() {
        const controller = AppState.aiAbort;
        if (controller) { try { controller.abort(); } catch {} }
        if (AppState.aiRunId) await AIService.stopRun(AppState.aiRunId);
    }

    static abortAIStream() {
        // 切题/退出时的静默中止：保留草稿，不弹确认；附件只属于当前题，一并清理
        const controller = AppState.aiAbort;
        if (controller) { try { controller.abort(); } catch {} }
        if (AppState.aiRunId) AIService.stopRun(AppState.aiRunId);
        AppState.aiAbort = null;
        AppState.aiRunId = '';
        AppState.aiBusy = false;
        AIAttachmentsState.reset();
    }

    static async sendAIMessage() {
        if (!getAccess().privateAllowed()) return;
        const messagesEl = document.getElementById('ai-messages');
        const panel = document.getElementById('ai-panel');
        const input = AIController.liveInput(panel);
        if (!input || !messagesEl || AppState.aiBusy) return;
        if (AIAttachmentsState.reading > 0) { toast('图片还在读取中，请稍候'); return; }

        const question = AppState.questions[AppState.currentQuestionIndex];
        const content = input.value.trim();
        // 用户附件优先：只有确认附件属于当前题、当前面板时才随请求发送；不一致就显式失败，不静默丢图。
        const attachmentsInSync = AppState.ui.aiPanelOpen && panel?.dataset?.questionId === String(question?.id)
            && AIAttachmentsState.panel === panel && AIAttachmentsState.questionId === String(question?.id);
        if (AIAttachmentsState.items.length && !attachmentsInSync) {
            toast('当前题的图片附件状态已变化，请重新确认后再发送');
            return;
        }
        const attachments = attachmentsInSync ? AIAttachmentsState.snapshot() : { images: [], names: [] };
        const images = [...attachments.images];
        const prompt = content || (images.length ? AI_IMAGE_ONLY_PROMPT : '');
        if (!question || !prompt) return;
        const questionId = String(question.id);

        // 发送生命周期从准备阶段开始：首个 await 之前就用现有 busy/controller 锁定本次发送，
        // 这样双击不会再并发准备，切题/停止也能中止准备本身。
        const controller = new AbortController();
        AppState.aiAbort = controller;
        AppState.aiRunId = '';
        this.aiBusyUi(true);
        // 本次发送的提前返回一律复位 busy，但不得覆盖期间已经接手的新运行。
        const releaseBusy = () => {
            if (AppState.aiAbort === controller) {
                AppState.aiAbort = null;
                AppState.aiRunId = '';
                this.aiBusyUi(false);
            }
        };
        // 准备完成、真正操作 DOM 之前必须复核：未被中止、仍是同一题、仍是有效面板。
        const stillCurrent = () => !controller.signal.aborted
            && String(AppState.questions[AppState.currentQuestionIndex]?.id) === questionId
            && document.getElementById('ai-panel') === panel
            && AIController.liveInput(panel) !== null;

        if (!AppState.aiProfileId) await AIService.loadProfiles();
        if (!stillCurrent()) { releaseBusy(); return; }
        if (!AppState.aiProfileId) {
            releaseBusy();
            toast('请先在设置中选择或配置 AI 服务');
            this.navigate('settings');
            return;
        }

        // 含附件的请求必须有通过 vision 测试的服务；失败时保留输入与附件，绝不静默丢图。
        const profile = AIService.activeProfile();
        const visionReady = profile?.capabilities?.vision === 'passed';
        if (attachments.images.length && !visionReady) {
            releaseBusy();
            toast('当前 AI 服务未通过图片能力测试，已取消发送；图片和文字仍保留在输入区');
            return;
        }
        // 用户图片优先占用名额，自动题图只补剩余张数。
        if (visionReady) {
            const room = AI_IMAGE_LIMIT - images.length;
            if (room > 0) images.push(...await AIService.questionImages(question, room));
        }
        if (!stillCurrent()) { releaseBusy(); return; }
        // 准备期间附件若被改动，显式中止，绝不让稍后的 clear() 把新图静默吞掉。
        const currentUrls = AIAttachmentsState.dataUrls();
        if (currentUrls.length !== attachments.images.length
            || currentUrls.some((url, index) => url !== attachments.images[index])) {
            releaseBusy();
            toast('发送准备期间图片已变化，已取消发送；图片和文字仍保留在输入区');
            return;
        }
        try {
            AIService.assertBodySize(AIService.chatBody({
                question,
                prompt,
                includePrivate: document.getElementById('ai-include-private-new')?.checked === true,
                images,
            }));
        } catch (error) {
            releaseBusy();
            toast(error.message);
            return;
        }

        messagesEl.querySelector('.ai-empty')?.remove();
        const userMsg = document.createElement('div');
        userMsg.className = 'ai-message user';
        const userBubble = document.createElement('div');
        userBubble.className = 'ai-message-bubble';
        if (content) userBubble.appendChild(document.createTextNode(content));
        if (attachments.images.length) userBubble.appendChild(AIController.buildUserImageStrip(attachments));
        userMsg.appendChild(userBubble);
        messagesEl.appendChild(userMsg);

        const aiMsg = document.createElement('div');
        aiMsg.className = 'ai-message assistant';
        aiMsg.innerHTML = '<div class="ai-message-bubble" id="ai-current-response">正在思考…</div>';
        messagesEl.appendChild(aiMsg);
        const responseEl = document.getElementById('ai-current-response');
        messagesEl.scrollTop = messagesEl.scrollHeight;

        // 只消费仍属于本次发送的输入与附件：准备期间用户新写的内容一律保留，不静默抹掉。
        if (input.value === content) {
            input.value = '';
            StorageService.saveAIDraft(question.id, '');
            window.DaguanAIReading?.fitInput();
        }
        AIAttachmentsState.clear();
        window.DaguanAIReading?.toLatest();
        window.DaguanAIReading?.refreshSections();
        const questionSnapshot = { content, images: attachments.images, names: attachments.names };

        let answer = '';
        let paintTimer = 0;
        let recoverOnFailure = false;
        try {
            const includePrivate = document.getElementById('ai-include-private-new')?.checked === true;
            const response = await AIService.chatStream({ question, prompt, includePrivate, images, signal: controller.signal });
            AppState.aiRunId = response.headers.get('X-Daguan-Run-Id') || '';
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const paint = () => {
                paintTimer = 0;
                if (!responseEl || !responseEl.isConnected) return;
                const paintContent = () => { responseEl.textContent = answer || '正在思考…'; };
                if (window.DaguanAIReading) window.DaguanAIReading.paintMessages(responseEl.closest('.ai-panel'), paintContent);
                else paintContent();
            };
            while (reader) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parsed = AIService.parseSseChunk('', buffer);
                buffer = parsed.rest;
                for (const evt of parsed.events) {
                    if (evt.type === 'started' && evt.runId) AppState.aiRunId = evt.runId;
                    if (evt.type === 'delta') { answer += evt.content || ''; if (!paintTimer) paintTimer = setTimeout(paint, 120); }
                    if (evt.type === 'error') throw new Error(evt.error || 'AI 生成失败');
                }
            }
            if (paintTimer) clearTimeout(paintTimer);
            if (String(AppState.questions[AppState.currentQuestionIndex]?.id) !== questionId) return;
            if (responseEl) {
                responseEl.removeAttribute('id');
                const finish = () => { responseEl.innerHTML = renderMarkdown(answer); };
                if (window.DaguanAIReading) window.DaguanAIReading.paintMessages(responseEl.closest('.ai-panel'), finish);
                else finish();
                window.DaguanAIReading?.refreshSections();
            }
        } catch (error) {
            if (paintTimer) clearTimeout(paintTimer);
            if (String(AppState.questions[AppState.currentQuestionIndex]?.id) !== questionId) return;
            const aborted = error?.name === 'AbortError';
            if (responseEl) {
                responseEl.removeAttribute('id');
                responseEl.innerHTML = aborted
                    ? `<div class="ai-error">已停止生成。${answer ? '<div class="ai-partial">' + renderMarkdown(answer) + '</div>' : ''}</div>`
                    : `<div class="ai-error"><div>AI 暂时没有完成回答：${escapeHtml(error.message || String(error))}</div><button class="ai-retry-btn" onclick="App.retryAIMessage()">${aborted ? '' : '重试'}</button></div>`;
                if (!aborted) {
                    const question = AppState.questions[AppState.currentQuestionIndex];
                    // 自动恢复要等 finally 复位 busy 之后再做，避免把「本轮生成中」误判成用户正在忙。
                    recoverOnFailure = true;
                    const retryBtn = responseEl.querySelector('.ai-retry-btn');
                    if (retryBtn) retryBtn.addEventListener('click', () => {
                        // 失败恢复：同一题的快照（文本 + 图片）放回输入区供重发；切题后不恢复过期内容。
                        if (!question || String(question.id) !== questionId) return;
                        // 与 sendAIMessage 同一守卫：restore 会作废在途批次，必须先拦住，否则会静默丢图。
                        if (AppState.aiBusy) return;
                        if (AIAttachmentsState.reading > 0) { toast('图片还在读取中，请稍候'); return; }
                        // 生成期间输入框可能被面板重渲染替换：只写当前面板里的实时节点。
                        const live = AIController.liveInput(panel);
                        if (!live) return;
                        live.value = questionSnapshot.content;
                        StorageService.saveAIDraft(question.id, questionSnapshot.content);
                        AIAttachmentsState.forQuestion(questionId).restore(questionSnapshot);
                        this.sendAIMessage();
                    });
                }
            }
        } finally {
            if (paintTimer) clearTimeout(paintTimer);
            window.DaguanAIReading?.refreshSections();
            releaseBusy();
            // busy 已复位：非中止失败且用户没另写草稿/加新图时，自动把本次图文快照放回输入区。
            if (recoverOnFailure) {
                AIController.restoreFailedSnapshot({
                    questionId, panel,
                    snapshot: questionSnapshot,
                    currentQuestion: AppState.questions[AppState.currentQuestionIndex],
                });
            }
        }
    }

    // 当前面板里的实时输入框：失败恢复/重试必须写这个节点，闭包里的旧节点可能已被重渲染替换。
    static liveInput(panel) {
        const current = document.getElementById('ai-panel');
        if (!panel || current !== panel) return null;
        const input = current.querySelector?.('#ai-input');
        return input && input.isConnected !== false ? input : null;
    }

    static restoreFailedSnapshot({ questionId, panel, snapshot, currentQuestion }) {
        if (!currentQuestion || String(currentQuestion.id) !== questionId) return false;
        if (AppState.aiBusy) return false;
        const input = AIController.liveInput(panel);
        if (!input) return false;
        if (AIAttachmentsState.panel !== panel || AIAttachmentsState.questionId !== questionId) return false;
        if (input.value.trim()) return false;
        if (AIAttachmentsState.items.length || AIAttachmentsState.reading > 0) return false;
        input.value = snapshot.content;
        StorageService.saveAIDraft(currentQuestion.id, snapshot.content);
        AIAttachmentsState.restore(snapshot);
        window.DaguanAIReading?.fitInput();
        return true;
    }

    static retryAIMessage() {
        const input = document.getElementById('ai-input');
        if (!input) return;
        if (!input.value.trim() && !AIAttachmentsState.items.length) return;
        this.sendAIMessage();
    }

    // 用户消息里的图片：全部走 DOM 赋值，文件名只作为属性/文本节点，不拼接 innerHTML。
    static buildUserImageStrip(attachments) {
        const strip = document.createElement('div');
        strip.className = 'ai-message-images';
        const names = Array.isArray(attachments?.names) ? attachments.names : [];
        (attachments?.images || []).forEach((dataUrl, index) => {
            const figure = document.createElement('figure');
            figure.className = 'ai-message-image';
            const img = document.createElement('img');
            img.src = dataUrl;
            img.alt = names[index] || `图片 ${index + 1}`;
            figure.appendChild(img);
            strip.appendChild(figure);
        });
        return strip;
    }

}

return { AIService, AI_COMPOSE_PROMPTS, AIViews, AIController, AIAttachments: AIAttachmentsState };
} };
})(window);

// 初始化 Markdown 解析器
const md = new window.markdownit({
    breaks: true,
    html: false, 
    linkify: true,
    typographer: true,
    highlight: function (str, lang) {
        if (lang && hljs.getLanguage(lang)) {
            try {
                return hljs.highlight(str, { language: lang }).value;
            } catch (__) {}
        }
        return ''; // use external default escaping
    }
});
// 全局变量
let chatHistory = [];
let isWaitingResponse = false;
let currentModel = 'GPT5_2';
let isExpanded = false;
let conversationId = null;
let authToken = null;
let isAuthenticated = false;

 const MAX_HISTORY_ITEMS = 100;

function normalizeMessageText(value) {
    if (typeof value === 'string') return value;
    if (value === null || typeof value === 'undefined') return '';
    try {
        return String(value);
    } catch (_) {
        return '';
    }
}

function normalizeTimestamp(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
    return typeof fallback === 'number' ? fallback : Date.now();
}

function normalizeHistoryItem(raw) {
    const now = Date.now();
    if (!raw || typeof raw !== 'object') {
        return {
            id: now.toString(),
            question: '',
            answer: '',
            timestamp: now
        };
    }
    const safeId = typeof raw.id === 'string'
        ? raw.id
        : (raw.id === null || typeof raw.id === 'undefined')
            ? now.toString()
            : String(raw.id);
    return {
        ...raw,
        id: safeId,
        question: normalizeMessageText(raw.question),
        answer: normalizeMessageText(raw.answer),
        timestamp: normalizeTimestamp(raw.timestamp, now)
    };
}

// Storage 封装：优先使用 utools.dbStorage / utools.db，回退到 localStorage
const storage = {
    getItem(key) {
        try {
            if (window.utools && utools.dbStorage && typeof utools.dbStorage.getItem === 'function') {
                const val = utools.dbStorage.getItem(key);
                return (typeof val === 'undefined') ? null : val;
            }
            if (window.utools && utools.db && typeof utools.db.get === 'function') {
                const doc = utools.db.get(`kv:${key}`);
                return doc ? (doc.value ?? null) : null;
            }
            return localStorage.getItem(key);
        } catch (e) {
            try { return localStorage.getItem(key); } catch (_) { return null; }
        }
    },
    setItem(key, value) {
        try {
            if (window.utools && utools.dbStorage && typeof utools.dbStorage.setItem === 'function') {
                utools.dbStorage.setItem(key, value);
                return;
            }
            if (window.utools && utools.db && typeof utools.db.put === 'function') {
                const old = utools.db.get(`kv:${key}`);
                const doc = old ? { ...old, value } : { _id: `kv:${key}`, value };
                utools.db.put(doc);
                return;
            }
            localStorage.setItem(key, value);
        } catch (e) {
            try { localStorage.setItem(key, value); } catch (_) {}
        }
    },
    removeItem(key) {
        try {
            if (window.utools && utools.dbStorage && typeof utools.dbStorage.removeItem === 'function') {
                utools.dbStorage.removeItem(key);
                return;
            }
            if (window.utools && utools.db && typeof utools.db.remove === 'function' && typeof utools.db.get === 'function') {
                const old = utools.db.get(`kv:${key}`);
                if (old) utools.db.remove(old);
                return;
            }
            localStorage.removeItem(key);
        } catch (e) {
            try { localStorage.removeItem(key); } catch (_) {}
        }
    }
};

// 一次性迁移旧的 localStorage 数据到 uTools 存储（仅当 uTools 可用且目标键不存在时）
function migrateLegacyLocalStorage() {
    try {
        if (!(window.utools)) return;
        const keys = ['chatAuth', 'selectedModel', 'chatHistory'];
        for (const key of keys) {
            try {
                const exists = storage.getItem(key);
                if (exists === null || typeof exists === 'undefined' || exists === '') {
                    const legacy = (() => { try { return localStorage.getItem(key); } catch (_) { return null; } })();
                    if (legacy !== null && typeof legacy !== 'undefined') {
                        try { storage.setItem(key, legacy); } catch (_) {}
                        try { localStorage.removeItem(key); } catch (_) {}
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
}

// 初始化
function init() {
    // 迁移一次旧数据（如果存在）
    migrateLegacyLocalStorage();
    // 检查是否已认证
    const savedAuth = storage.getItem('chatAuth');
    if (savedAuth) {
        try {
            const authData = JSON.parse(savedAuth);
            conversationId = authData.conversationId;
            authToken = authData.token;
            // 验证保存的认证信息
            verifyAuth(conversationId, authToken, true);
        } catch (e) {
            // 认证数据无效，显示登录界面
            showAuthModal();
        }
    } else {
        showAuthModal();
    }
    
    // 认证输入框事件监听
    const conversationIdInput = document.getElementById('conversationId');
    const authTokenInput = document.getElementById('authToken');
    
    if (conversationIdInput) {
        conversationIdInput.addEventListener('keydown', handleAuthKeyDown);
    }
    if (authTokenInput) {
        authTokenInput.addEventListener('keydown', handleAuthKeyDown);
    }
}

// 初始化聊天界面
function initChatInterface() {
    loadChatHistory();
    renderMessages();
    
    // 输入框事件监听
    const input = document.getElementById('messageInput');
    input.addEventListener('input', handleInputChange);
    input.addEventListener('keydown', handleKeyDown);
    
    // 模型选择按钮事件监听
    const modelBtns = document.querySelectorAll('.model-btn');
    modelBtns.forEach(btn => {
        btn.addEventListener('click', () => selectModel(btn.dataset.model));
    });
    
    // 初始化默认/持久化的模型选择
    try {
        const savedModel = storage.getItem('selectedModel');
        const modelToApply = savedModel || currentModel || 'GPT5_2';
        currentModel = modelToApply;
        document.querySelectorAll('.model-btn').forEach(btn => {
            if (btn.dataset.model === modelToApply) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    } catch (e) {
        // 如果持久化存储不可用，至少默认选中 GPT5
        const defaultBtn = document.querySelector('.model-btn[data-model="GPT5_2"]');
        if (defaultBtn) defaultBtn.classList.add('active');
    }
}

// 加载聊天历史
function loadChatHistory() {
    const saved = storage.getItem('chatHistory');
    if (!saved) {
        chatHistory = [];
        return;
    }
    let parsed;
    try {
        parsed = JSON.parse(saved);
    } catch (_) {
        parsed = [];
    }
    if (!Array.isArray(parsed)) {
        parsed = [];
    }
    chatHistory = parsed.map(item => normalizeHistoryItem(item));
    if (chatHistory.length > MAX_HISTORY_ITEMS) {
        chatHistory = chatHistory.slice(-MAX_HISTORY_ITEMS);
    }
    saveChatHistory();
}

// 保存聊天历史
function saveChatHistory() {
    // 限制最大条数（移除最旧的，保留最新的）
    while (chatHistory.length > MAX_HISTORY_ITEMS) {
        chatHistory.shift();
    }

    let success = false;
    while (!success && chatHistory.length > 0) {
        try {
            storage.setItem('chatHistory', JSON.stringify(chatHistory));
            success = true;
        } catch (e) {
            if (e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
                console.warn('存储空间不足，正在删除最旧的记录...');
                chatHistory.shift();
            } else {
                console.error('保存历史记录时发生未知错误:', e);
                break;
            }
        }
    }
}

// 代码块复制按钮逻辑见文件后部 addCopyButtons() 实现

// 渲染消息
function renderMessages() {
    const messagesContainer = document.getElementById('chatMessages');
    messagesContainer.innerHTML = chatHistory.map((item, index) => {
        const safeQuestion = normalizeMessageText(item.question);
        const safeAnswer = normalizeMessageText(item.answer);
        const questionTime = new Date(normalizeTimestamp(item.timestamp)).toLocaleString('zh-CN');
        const questionHtml = `
            <div class="message user-message" data-index="${index}" data-type="question">
                <div class="message-avatar">🧑‍💻</div>
                <div class="message-content">
                    <div class="message-time">${questionTime}</div>
                    <div class="message-text">${escapeHtml(safeQuestion)}</div>
                    <div class="message-actions">
                        <button class="message-action-btn" onclick="copyMessage(${index}, 'question')" title="复制">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                        </button>
                        <button class="message-action-btn delete-btn" onclick="deleteMessage(${index})" title="删除">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
        const htmlContent = md.render(safeAnswer);
        
        const answerHtml = `
            <div class="message assistant-message" data-index="${index}" data-type="answer">
                <div class="message-avatar">🤖</div>
                <div class="message-content">
                    <div class="message-time">${questionTime}</div>
                    <div class="message-text markdown-body">${htmlContent}</div>
                    <div class="message-actions">
                        <button class="message-action-btn" onclick="copyMessage(${index}, 'answer')" title="复制">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                        </button>
                        <button class="message-action-btn delete-btn" onclick="deleteMessage(${index})" title="删除">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        return questionHtml + answerHtml;
    }).join('');

    // 渲染完成后执行代码高亮与代码块复制按钮注入
    try { hljs.highlightAll(); } catch (_) {}
    try { addCopyButtons(); } catch (_) {}

    // 滚动到底部
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// 添加到历史记录
function addToHistory(question, answer) {
    const historyItem = normalizeHistoryItem({
        id: Date.now().toString(),
        question,
        answer,
        timestamp: Date.now()
    });

    chatHistory.push(historyItem);
    saveChatHistory();
    renderMessages();
}

function appendReplyLimitInstruction(originalMessage) {
    const select = document.getElementById('replyLimitSelect');
    if (!select) return originalMessage;
    const limit = select.value;
    if (!limit) return originalMessage;
    return `${originalMessage}\n#回复不超过${limit}行`;
}

// 发送消息
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (!message || isWaitingResponse) return;
    
    const contextEnabled = document.getElementById('toggleContextButton').checked;
    
    if (contextEnabled) {
        if (chatHistory.length === 0) {
            showToast('历史记录为空, 不支持上下文');
            return;
        }
        
        await showHistorySelect();
        return;
    }
    
    await sendRequest();
}

// 发送请求
async function sendRequest(contextQuestion = null, contextAnswer = null) {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    if (!message) return;

    // 如果第一行是“原封不动”，直接回显用户问题
    const firstLine = message.split(/\r?\n/)[0].trim();
    if (firstLine === '原封不动') {
        const finalMessage = appendReplyLimitInstruction(message);
        input.value = '';
        handleInputChange();
        addToHistory(finalMessage, message);
        return;
    }

    const finalMessage = appendReplyLimitInstruction(message);

    input.value = '';
    handleInputChange();

    // 显示加载状态
    isWaitingResponse = true;
    
    // 显示用户消息
    const messagesContainer = document.getElementById('chatMessages');
    const userMessageDiv = document.createElement('div');
    userMessageDiv.className = 'message user-message';
    userMessageDiv.innerHTML = `
        <div class="message-avatar">🧑‍💻</div>
        <div class="message-content">
            <div class="message-time">${new Date().toLocaleString('zh-CN')}</div>
            <div class="message-text">${escapeHtml(finalMessage)}</div>
        </div>
    `;
    messagesContainer.appendChild(userMessageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    showLoadingMessage();

    try {
        // 调用AI接口
        const response = await callAIAPI(finalMessage, contextQuestion, contextAnswer);
        removeLoadingMessage();
        
        // 添加到历史记录
        addToHistory(finalMessage, response);
    } catch (error) {
        removeLoadingMessage();
        const errorAnswer = '抱歉发生了错误，请稍后再试';
        addToHistory(finalMessage, errorAnswer);
        console.error('API Error:', error);
    } finally {
        isWaitingResponse = false;
    }
}

// 显示加载消息
function showLoadingMessage() {
    const messagesContainer = document.getElementById('chatMessages');
    const loadingDiv = document.createElement('div');
    loadingDiv.id = 'loadingMessage';
    loadingDiv.className = 'message assistant-message';
    loadingDiv.innerHTML = `
        <div class="message-avatar">🤖</div>
        <div class="message-content">
            <div class="message-text">
                <div class="loading-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </div>
        </div>
    `;
    messagesContainer.appendChild(loadingDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// 移除加载消息
function removeLoadingMessage() {
    const loadingMsg = document.getElementById('loadingMessage');
    if (loadingMsg) {
        loadingMsg.remove();
    }
}

// 调用AI API（需要根据实际接口修改）
async function callAIAPI(message, contextQuestion = null, contextAnswer = null) {
    // 需要已登录
    if (!isAuthenticated || !conversationId || !authToken) {
        throw new Error('请先登录');
    }

    const baseUrl = 'https://ai.ufun.net/chatapi/chat/message';
    const commonHeaders = {
        'Accept-Language': 'zh-CN',
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
    };

    // 追问时入参
    const messages = (contextQuestion && contextAnswer)
        ? [
            { content: contextQuestion, role: 'user', contentFiles: [] },
            { content: contextAnswer, role: 'assistant' }
          ]
        : [];

    const topicId = isNaN(Number(conversationId)) ? conversationId : Number(conversationId);
    // 构建最终内容：在特定模型下，问题末尾追加 Markdown 回复提示
    const appendMarkdownHint = (currentModel === 'GPT5Pro' || currentModel === 'o3' || currentModel === 'GPT5');
    const finalContent = appendMarkdownHint ? `${message}\n# please reply in markdown format` : message;
    const payload = {
        topicId: topicId,
        messages: messages,
        content: finalContent,
        contentFiles: []
    };

    // 第一步：创建对话，获取轮询池ID
    let initRes;
    const controller1 = new AbortController();
    const timeout1 = setTimeout(() => controller1.abort(), 30000);
    try {
        initRes = await fetch(baseUrl, {
            method: 'POST',
            headers: commonHeaders,
            body: JSON.stringify(payload),
            signal: controller1.signal
        });
    } finally {
        clearTimeout(timeout1);
    }

    if (!initRes.ok) {
        const text = await initRes.text().catch(() => '');
        throw new Error(text || `网络错误：${initRes.status}`);
    }

    let initData;
    try {
        initData = await initRes.json();
    } catch (_) {
        throw new Error('接口返回非JSON');
    }

    const messageFromServer = (initData && typeof initData.message === 'string') ? initData.message : '';
    if (messageFromServer) {
        // 后端直接返回消息
        removeLoadingMessage();
        const messagesContainer = document.getElementById('chatMessages');
        const streamDiv = document.createElement('div');
        streamDiv.className = 'message assistant-message';
        streamDiv.innerHTML = `
            <div class="message-avatar">🤖</div>
            <div class="message-content">
                <div class="message-time">${new Date().toLocaleString('zh-CN')}</div>
                <div class="message-text markdown-body">${md.render(messageFromServer)}</div>
            </div>`;
        messagesContainer.appendChild(streamDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        return messageFromServer;
    }

    let getId;
    try {
        const result = initData?.result;
        getId = Array.isArray(result) ? result[result.length - 1] : null;
        if (!getId) throw new Error('empty id');
    } catch (e) {
        throw new Error(`获取对话ID异常: ${e?.message || String(e)}`);
    }

    // 为流式输出准备UI：用一个assistant消息替换加载占位
    removeLoadingMessage();
    const messagesContainer = document.getElementById('chatMessages');
    const streamDiv = document.createElement('div');
    streamDiv.className = 'message assistant-message';
    streamDiv.innerHTML = `
        <div class="message-avatar">🤖</div>
        <div class="message-content">
            <div class="message-time">${new Date().toLocaleString('zh-CN')}</div>
            <div class="message-text markdown-body">思考中...</div>
        </div>`;
    messagesContainer.appendChild(streamDiv);
    const textEl = streamDiv.querySelector('.message-text');
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // 第二步：获取流式结果
    const sendHeaders = { ...commonHeaders };
    const sendUrl = `${baseUrl}/${getId}`;
    let sendRes;
    // 去除客户端超时中断，避免长时间流式被中断
    sendRes = await fetch(sendUrl, {
        method: 'POST',
        headers: sendHeaders
    });

    if (!sendRes.ok) {
        const errText = await sendRes.text().catch(() => '');
        if (textEl) textEl.textContent = errText || `网络错误：${sendRes.status}`;
        throw new Error(errText || `网络错误：${sendRes.status}`);
    }

    // 读取流式内容
    let resultText = '';
    let extraHtml = '';
    let isCode = false;
    let cite = false;
    let table = false;
    let lastLine = null;

    const reader = sendRes.body && sendRes.body.getReader ? sendRes.body.getReader() : null;
    if (!reader) {
        // 老环境 fallback
        const whole = await sendRes.text();
        resultText = whole || '';
        if (textEl) {
            const htmlContent = md.render(resultText);
            textEl.innerHTML = htmlContent;
            hljs.highlightAll();
            addCopyButtons();
        }

        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        // 钱包请求（异步）
        fetch('https://ai.ufun.net/chatapi/member/wallet', { method: 'GET', headers: commonHeaders }).catch(() => {});
        return resultText.trim() || 'AI服务异常繁忙,请稍后重试！😢';
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunkStr = decoder.decode(value || new Uint8Array(), { stream: true });
            buffer += chunkStr;

            let lines = buffer.split(/\r?\n/);
            buffer = lines.pop(); // 保留不完整行

            for (let rawLine of lines) {
                if (!rawLine) continue;
                let line = String(rawLine);

                // 代码块切换
                if (line.trim().startsWith('```')) {
                    isCode = !isCode;
                }

                try {
                    if (!isCode) {
                        let isListItem = false;

                        // 去掉结尾的 \n\n 字面量
                        if (line.trim().endsWith('\\n\\n')) {
                            line = line.trim().slice(0, -4);
                        }

                        // 空行跳过
                        if (!line.trim()) continue;

                        // 引用块结束时补换行
                        if (!line.trim().startsWith('>') && cite) resultText += '  \n';
                        if (line.trim().startsWith('>')) {
                            cite = true;
                        } else {
                            cite = false;
                        }

                        // 分隔符前加换行
                        if (/^[-=*_]+$/.test(line.trim())) resultText += '  \n';
                        // 列表项判定
                        if (/^\s*(?:[+\-*]\s+|\d+\.\s+|\d+\)\s+)/.test(line)) isListItem = true;

                        // 表格判定
                        const s = line.trim().replace(/`[^`]*`/g, '');
                        let is_table;
                        if (/^\|.*\|$/.test(s)) {
                            is_table = true;
                        } else if (line.indexOf('|') === -1) {
                            is_table = false;
                        } else if (lastLine && String(lastLine).includes('|')) {
                            is_table = true;
                        } else {
                            is_table = false;
                        }
                        if (table && !is_table) resultText += '  \n\n';
                        table = is_table;
                        lastLine = line;

                        if (isListItem) {
                            resultText += line + '   \n\n';
                        } else {
                            resultText += line + '   \n';
                        }

                        // 视频链接转视频标签
                        if (line.includes('视频生成成功，[点击这里](https:')) {
                            const m = line.match(/https:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^)\s]*/);
                            if (m && m[0]) {
                                extraHtml += '  <br/>' +
                                    `<video width="320" height="240" controls><source src="${m[0]}" type="video/mp4">您的浏览器不支持视频播放。</video>` +
                                    '  <br/>';
                            }
                        }
                    } else {
                        // 代码块内部原样输出
                        resultText += line + '   \n';
                    }
                } catch (e) {
                    // 忽略单行处理异常，继续流
                }

                if (textEl) {
                    textEl.innerHTML = md.render(resultText) + extraHtml;
                    hljs.highlightAll();
                    addCopyButtons();
                }
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
        }
    } catch (e) {
        // 网络中断等异常
        try { sendRes.body?.cancel && sendRes.body.cancel(); } catch (_) {}
        if (textEl) {
            textEl.innerHTML = md.render('网络中断，请重试');
            hljs.highlightAll();
            addCopyButtons();
        }
        return '网络中断，请重试';
    }

    // 处理缓冲中残留内容
    if (buffer && buffer.trim()) {
        resultText += buffer + '\n';
        if (textEl) {
            const htmlContent = md.render(resultText);
            textEl.innerHTML = htmlContent;
            hljs.highlightAll();
            addCopyButtons();
        }

    }

    if (!resultText.trim()) {
        const fallback = 'AI服务异常繁忙,请稍后重试！😢';
        if (textEl) {
            const htmlContent = md.render(fallback);
            textEl.innerHTML = htmlContent;
            hljs.highlightAll();
            addCopyButtons();
        }

        return fallback;
    }

    // 钱包（异步即可）
    fetch('https://ai.ufun.net/chatapi/member/wallet', {
        method: 'GET',
        headers: commonHeaders
    }).then(r => r.text()).then(t => console.log('wallet:', t)).catch(e => console.log('获取钱包状态异常', e));

    return resultText.trim();
}

// 处理输入变化
function handleInputChange() {
    const input = document.getElementById('messageInput');
    
    // 自动调整高度
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

// 处理键盘事件
function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

// 显示历史记录选择弹窗
async function showHistorySelect() {
    const historySelectList = document.getElementById('historySelectList');
    
    // 反转历史记录数组，使最新的记录显示在最上面
    const reversedHistory = [...chatHistory].reverse();
    
    historySelectList.innerHTML = reversedHistory.map((item, index) => {
        const displayNumber = chatHistory.length - index;
        return `
            <div class="history-select-item">
                <input type="radio" name="historySelect" id="history-${item.id}" data-id="${item.id}" ${index === 0 ? 'checked' : ''}>
                <label for="history-${item.id}">
                    <div class="history-number">#${displayNumber}</div>
                    <pre style="margin:0;white-space:pre-wrap;word-break:break-all;font-family:inherit;font-size:14px;">${item.question.substring(0, 120)}${item.question.length > 120 ? '…' : ''}</pre>
                    <div style="font-size: 12px; color: #666;">${new Date(item.timestamp).toLocaleString()}</div>
                </label>
            </div>
        `;
    }).join('');
    
    document.getElementById('historySelectOverlay').style.display = 'flex';
}

// 关闭历史记录选择弹窗
function closeHistorySelect() {
    document.getElementById('historySelectOverlay').style.display = 'none';
}


// 确认历史记录选择并发送请求
async function confirmHistorySelect() {
    const selectedItem = document.querySelector('#historySelectList input[type="radio"]:checked');
    
    if (!selectedItem) {
        showToast('请选择一条历史记录');
        return;
    }
    
    const itemId = selectedItem.getAttribute('data-id');
    const item = chatHistory.find(h => h.id === itemId);
    
    if (!item) {
        showToast('历史记录项不存在');
        return;
    }
    
    const userMessage = item.question;
    const assistantMessage = item.answer;
    
    document.getElementById('historySelectOverlay').style.display = 'none';
    
    await sendRequest(userMessage, assistantMessage);
}

// 切换展开/收起
function toggleExpand() {
    isExpanded = !isExpanded;
    const wrapper = document.getElementById('inputWrapper');
    const icon = document.getElementById('expandIcon');
    
    if (isExpanded) {
        wrapper.classList.add('expanded');
        icon.textContent = '⬇';
    } else {
        wrapper.classList.remove('expanded');
        icon.textContent = '⬆';
    }
}

// 选择模型
async function selectModel(modelName) {
    if (modelName === currentModel) return;

    // 必须先认证
    if (!isAuthenticated || !conversationId || !authToken) {
        showToast('请先登录');
        return;
    }

    // 显示自定义确认对话框
    const confirmed = await confirmDialog(`是否确认选择 ${modelName}？`, {
        title: '切换模型',
        type: 'info',
        confirmText: '切换',
        cancelText: '取消'
    });
    if (!confirmed) return;

    const prevModel = currentModel;
    setModelButtonsDisabled(true);

    try {
        const data = await saveModelOnServer(modelName);

        // 切换成功，更新状态与持久化
        currentModel = modelName;
        try { storage.setItem('selectedModel', modelName); } catch (_) {}

        // 更新按钮状态
        document.querySelectorAll('.model-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.model === modelName) {
                btn.classList.add('active');
            }
        });

        console.log('切换到模型成功:', modelName, data);
        showToast(`✅已切换至 ${modelName}`);
    } catch (err) {
        // 失败还原UI
        console.error('切换模型失败:', err);
        document.querySelectorAll('.model-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.model === prevModel) {
                btn.classList.add('active');
            }
        });
        currentModel = prevModel;
        showToast(err?.message || '切换模型失败');
    } finally {
        setModelButtonsDisabled(false);
    }
}

// 模型名到服务端ID映射
const MODEL_ID_MAP = {
    claude_sonnet: 'claude-sonnet-4-5-20250929',
    GPT5_2: 'gpt-5.2',
    claude_opus: 'claude-opus-4-5-20251101',
    o3: 'o3',
    stock: 'gpt-4o-mini'
};

const DEFAULT_MODEL_PARAMS = {
    chatPluginIds: [],
    frequency_penalty: null,
    max_tokens: 4096,
    model: '',
    presence_penalty: null,
    requestMsgCount: 0,
    speechVoice: 'Alloy',
    temperature: 0.8
};

const MODEL_CUSTOM_PARAMS = {
    stock: {
        chatPluginIds: ['JuHeApiCommon_MrMVMj5'],
        max_tokens: 2000,
        model: 'gpt-4o-mini'
    }
};

// 实际调用后端接口保存模型设置
async function saveModelOnServer(modelName) {
    const serverModel = MODEL_ID_MAP[modelName] || modelName;

    const customParams = MODEL_CUSTOM_PARAMS[modelName] || {};
    const paramsObj = {
        ...DEFAULT_MODEL_PARAMS,
        model: serverModel,
        ...customParams
    };
    if (!paramsObj.model) paramsObj.model = serverModel;

    const payload = {
        id: isNaN(Number(conversationId)) ? conversationId : Number(conversationId),
        isLock: true,
        params: JSON.stringify(paramsObj),
        roleId: 0,
        roleInfo: null,
        systemMessage: '',
        title: '1'
    };

    const res = await fetch('https://ai.ufun.net/chatapi/chat/save', {
        method: 'POST',
        headers: {
            'Accept-Language': 'zh-CN',
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `网络错误：${res.status}`);
    }

    let data;
    try {
        data = await res.json();
    } catch (e) {
        throw new Error('接口返回非JSON');
    }

    if (data?.code === 200 || data?.type === 'success') {
        return data;
    }

    throw new Error(data?.message || '切换模型失败');
}

// 禁用/启用模型按钮
function setModelButtonsDisabled(disabled) {
    document.querySelectorAll('.model-btn').forEach(btn => {
        try { btn.disabled = !!disabled; } catch (_) {}
    });
}

// 重置认证UI状态，避免按钮卡在加载中
function resetAuthUI() {
    const submitBtn = document.getElementById('authSubmitBtn');
    const btnText = document.getElementById('authBtnText');
    const loading = document.getElementById('authLoading');
    const errorDiv = document.getElementById('authError');
    if (submitBtn) submitBtn.disabled = false;
    if (btnText) btnText.style.display = 'inline';
    if (loading) loading.style.display = 'none';
    if (errorDiv) errorDiv.textContent = '';
}

// 显示认证模态框
function showAuthModal() {
    const authModal = document.getElementById('authModal');
    const appContainer = document.getElementById('appContainer');
    if (authModal) authModal.style.display = 'flex';
    if (appContainer) appContainer.style.display = 'none';
    // 每次显示登录窗口时重置按钮与提示状态
    resetAuthUI();
}

// 隐藏认证模态框
function hideAuthModal() {
    const authModal = document.getElementById('authModal');
    const appContainer = document.getElementById('appContainer');
    if (authModal) authModal.style.display = 'none';
    if (appContainer) appContainer.style.display = 'flex';
}

// 退出登录
async function logout() {
    const confirmed = await confirmDialog('确定要退出登录吗？', {
        title: '退出登录',
        type: 'warning',
        confirmText: '退出',
        cancelText: '取消',
        icon: '🚪'
    });
    if (!confirmed) return;

    // 清除认证信息
    isAuthenticated = false;
    conversationId = null;
    authToken = null;
    try { storage.removeItem('chatAuth'); } catch (_) {}

    // 显示认证模态框并隐藏应用
    resetAuthUI();
    showAuthModal();
    setTimeout(() => {
        const conversationIdInput = document.getElementById('conversationId');
        try { conversationIdInput && conversationIdInput.focus(); } catch (_) {}
    }, 0);

    showToast('已退出');
}

// 处理认证输入框的Enter键
function handleAuthKeyDown(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitAuth();
    }
}

// 提交认证
async function submitAuth() {
    const conversationIdInput = document.getElementById('conversationId');
    const authTokenInput = document.getElementById('authToken');
    const errorDiv = document.getElementById('authError');
    const submitBtn = document.getElementById('authSubmitBtn');
    const btnText = document.getElementById('authBtnText');
    const loading = document.getElementById('authLoading');
    
    const convId = conversationIdInput.value.trim();
    const token = authTokenInput.value.trim();
    
    // 验证输入
    if (!convId) {
        errorDiv.textContent = '请输入对话ID';
        return;
    }
    if (!token) {
        errorDiv.textContent = '请输入Token';
        return;
    }
    
    // 显示加载状态
    submitBtn.disabled = true;
    btnText.style.display = 'none';
    loading.style.display = 'inline-flex';
    errorDiv.textContent = '';
    
    try {
        await verifyAuth(convId, token, false);
    } catch (error) {
        // 恢复按钮状态
        submitBtn.disabled = false;
        btnText.style.display = 'inline';
        loading.style.display = 'none';
    }
}

// 验证认证信息
async function verifyAuth(convId, token, isSilent) {
    const errorDiv = document.getElementById('authError');
    const submitBtn = document.getElementById('authSubmitBtn');
    const btnText = document.getElementById('authBtnText');
    const loading = document.getElementById('authLoading');
    
    try {
        // 实际调用校验接口
        const chatIdParam = isNaN(Number(convId)) ? convId : Number(convId);
        // 30秒超时控制，与示例脚本保持一致
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        let res;
        try {
            res = await fetch('https://ai.ufun.net/chatapi/chat/topic/messages', {
                method: 'POST',
                headers: {
                    'Accept-Language': 'zh-CN',
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    id: chatIdParam,
                    page: 1,
                    pageSize: 20
                }),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeoutId);
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(text || `网络错误：${res.status}`);
        }
        let data;
        try {
            data = await res.json();
        } catch (e) {
            throw new Error('接口返回非JSON');
        }
        const hasItems = Array.isArray(data?.result?.items) && data.result.items.length > 0;
        const ok = (data?.type === 'success' && hasItems);
        if (!ok) {
            throw new Error(data?.message || '认证失败：无效的对话ID或Token');
        }
        
        // 认证成功
        conversationId = convId;
        authToken = token;
        isAuthenticated = true;
        
        // 保存认证信息（持久化）
        storage.setItem('chatAuth', JSON.stringify({
            conversationId: convId,
            token: token
        }));
        
        // 登录成功后强制默认模型为 GPT5_2（覆盖本地持久化）
        try { storage.setItem('selectedModel', 'GPT5_2'); } catch (_) {}
        currentModel = 'GPT5_2';
        
        // 重置登录按钮状态，避免下次显示时仍为加载状态
        resetAuthUI();
        // 隐藏认证模态框，显示聊天界面
        hideAuthModal();
        
        // 初始化聊天界面
        initChatInterface();
        
        // 将模型设置同步到服务端（静默，不打断UI）
        try {
            saveModelOnServer('GPT5_2').catch(err => console.warn('初始化设置模型为GPT5_2失败:', err));
        } catch (_) {}
        
    } catch (error) {
        console.error('Auth Error:', error);
        // 统一超时错误提示
        if (error && (error.name === 'AbortError' || (typeof error.message === 'string' && /abort/i.test(error.message)))) {
            try { error.message = '请求超时，请检查网络或稍后再试'; } catch (_) {}
        }
        
        if (!isSilent) {
            if (errorDiv) {
                errorDiv.textContent = error.message || '认证失败，请检查您的对话ID和Token';
            }
            
            // 恢复按钮状态
            if (submitBtn) submitBtn.disabled = false;
            if (btnText) btnText.style.display = 'inline';
            if (loading) loading.style.display = 'none';
        } else {
            // 静默失败，显示登录界面
            storage.removeItem('chatAuth');
            showAuthModal();
        }
        
        throw error;
    }
}

// HTML转义函数
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 复制到剪贴板的通用方法（带回退方案）
function copyTextToClipboard(text) {
    // 首选异步 Clipboard API
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    // 非安全上下文或浏览器不支持时，使用回退方案
    return fallbackCopy(text);

    function fallbackCopy(t) {
        return new Promise((resolve, reject) => {
            try {
                const textarea = document.createElement('textarea');
                textarea.value = t;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.top = '-9999px';
                textarea.style.left = '-9999px';
                document.body.appendChild(textarea);

                const selection = document.getSelection();
                const selectedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

                textarea.select();
                textarea.setSelectionRange(0, textarea.value.length);

                let successful = false;
                try {
                    successful = document.execCommand('copy');
                } catch (e) {
                    successful = false;
                }

                document.body.removeChild(textarea);

                if (selectedRange && selection) {
                    selection.removeAllRanges();
                    selection.addRange(selectedRange);
                }

                if (successful) {
                    resolve();
                } else {
                    reject(new Error('execCommand copy failed'));
                }
            } catch (err) {
                reject(err);
            }
        });
    }
}

// 复制消息
function copyMessage(index, type) {
    const item = chatHistory[index];
    if (!item) {
        showToast('复制失败：内容不存在');
        return;
    }
    const text = type === 'question' ? item.question : item.answer;

    copyTextToClipboard(text).then(() => {
        // 显示复制成功提示
        showToast('已复制');
    }).catch(err => {
        console.error('复制失败:', err);
        showToast('复制失败：浏览器不支持或未授权');
    });
}

// 为代码块添加复制按钮（不影响消息操作按钮）
let __codeClipboardInstance = null;
function addCopyButtons() {
    try {
        const codePres = document.querySelectorAll('.assistant-message .message-text pre');
        codePres.forEach(pre => {
            // 已注入则跳过
            if (pre.dataset.copyButtonInjected === '1') return;

            // 仅在包含 <code> 时处理
            const code = pre.querySelector('code');
            const textToCopy = code ? code.innerText : pre.innerText;
            if (!textToCopy || !textToCopy.trim()) {
                pre.dataset.copyButtonInjected = '1';
                return;
            }

            // 确保容器可相对定位
            if (!pre.style.position) pre.style.position = 'relative';

            const btn = document.createElement('button');
            btn.type = 'button';
            // 使用独立类避免与消息操作按钮样式冲突
            btn.className = 'code-copy-btn';
            // 内联样式，避免依赖全局 .copy-btn 样式
            btn.style.position = 'absolute';
            btn.style.top = '6px';
            btn.style.right = '6px';
            btn.style.padding = '2px 6px';
            btn.style.fontSize = '12px';
            btn.style.backgroundColor = '#4CAF50';
            btn.style.color = '#fff';
            btn.style.border = 'none';
            btn.style.borderRadius = '4px';
            btn.style.cursor = 'pointer';
            btn.style.opacity = '0.8';
            btn.style.transition = 'opacity 0.2s ease';
            btn.onmouseenter = () => btn.style.opacity = '1';
            btn.onmouseleave = () => btn.style.opacity = '0.8';
            btn.textContent = '复制';
            btn.setAttribute('data-clipboard-text', textToCopy);

            pre.appendChild(btn);
            pre.dataset.copyButtonInjected = '1';
        });

        // 初始化（委托选择器，后续新增也生效）
        if (!__codeClipboardInstance && typeof ClipboardJS !== 'undefined') {
            __codeClipboardInstance = new ClipboardJS('.code-copy-btn');
            __codeClipboardInstance.on('success', (e) => {
                try {
                    e.trigger.textContent = '已复制';
                    setTimeout(() => { e.trigger.textContent = '复制'; }, 1500);
                } catch (_) {}
                e.clearSelection();
            });
            __codeClipboardInstance.on('error', (e) => {
                try {
                    e.trigger.textContent = '复制失败';
                    setTimeout(() => { e.trigger.textContent = '复制'; }, 1500);
                } catch (_) {}
            });
        }
    } catch (err) {
        // 静默失败，不影响正常渲染
        console.warn('addCopyButtons failed:', err);
    }
}

// 删除消息
async function deleteMessage(index) {
    const confirmed = await confirmDialog('确定要删除这条消息吗？', {
        title: '删除消息',
        type: 'danger',
        confirmText: '删除',
        cancelText: '取消'
    });
    if (!confirmed) return;
    chatHistory.splice(index, 1);
    saveChatHistory();
    renderMessages();
    showToast('已删除');
}

// 显示提示信息
function showToast(message) {
    // 移除已存在的toast
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // 触发动画
    setTimeout(() => toast.classList.add('show'), 10);
    
    // 3秒后移除
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 通用确认弹窗（Promise 版）
function confirmDialog(message, options = {}) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('confirmOverlay');
        if (!overlay) {
            // 回退到原生 confirm
            resolve(window.confirm(typeof message === 'string' ? message : '确认操作')); 
            return;
        }
        const modal = overlay.querySelector('.confirm-modal');
        const titleEl = document.getElementById('confirmTitle');
        const iconElId = 'confirmIcon';
        const messageEl = document.getElementById('confirmMessage');
        const confirmBtn = document.getElementById('confirmConfirmBtn');
        const cancelBtn = document.getElementById('confirmCancelBtn');
        const closeBtn = document.getElementById('confirmCloseBtn');

        const {
            title = '确认操作',
            type = 'warning', // info | success | warning | danger
            confirmText = '确认',
            cancelText = '取消',
            icon = null
        } = options || {};

        // 设置标题与图标
        if (titleEl) {
            titleEl.innerHTML = `<span class="confirm-icon" id="${iconElId}">⚠️</span>${title}`;
        }
        const iconEl = document.getElementById(iconElId);
        if (iconEl) {
            if (icon && typeof icon === 'string') {
                iconEl.textContent = icon;
            } else {
                // 根据类型选择默认 emoji
                const defaultIcon = {
                    info: 'ℹ️',
                    success: '✅',
                    warning: '⚠️',
                    danger: '🗑️'
                }[type] || '⚠️';
                iconEl.textContent = defaultIcon;
            }
        }

        if (messageEl) messageEl.textContent = message;
        if (confirmBtn) confirmBtn.textContent = confirmText;
        if (cancelBtn) cancelBtn.textContent = cancelText;

        // 设置主题样式
        if (modal) {
            modal.className = `confirm-modal ${type}`;
        }

        // 显示
        overlay.style.display = 'flex';
        requestAnimationFrame(() => overlay.classList.add('show'));

        // 焦点管理
        const prevActive = document.activeElement;
        setTimeout(() => {
            if (confirmBtn) confirmBtn.focus();
        }, 0);

        // 事件处理与清理
        const onConfirm = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onOverlayClick = (e) => { if (e.target === overlay) cleanup(false); };
        const onKeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                cleanup(false);
            } else if (e.key === 'Enter') {
                // Enter 作为确认
                e.preventDefault();
                cleanup(true);
            }
        };

        confirmBtn && confirmBtn.addEventListener('click', onConfirm);
        cancelBtn && cancelBtn.addEventListener('click', onCancel);
        closeBtn && closeBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlayClick);
        document.addEventListener('keydown', onKeydown);

        function cleanup(result) {
            confirmBtn && confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn && cancelBtn.removeEventListener('click', onCancel);
            closeBtn && closeBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlayClick);
            document.removeEventListener('keydown', onKeydown);
            overlay.classList.remove('show');
            setTimeout(() => {
                overlay.style.display = 'none';
                if (prevActive && typeof prevActive.focus === 'function') {
                    try { prevActive.focus(); } catch (_) {}
                }
                resolve(result);
            }, 200);
        }
    });
}

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', init);

// WebAZ — AI assistant domain (classic multi-script split, slice E / app-ai.js)
//
// Loaded as a CLASSIC script in this order (index.html):
//   i18n → app-admin → app-contribution → app-ai → app-discover → app-profile → app-account → app-shop → app-listings → app-seller → app.js (source of truth: index.html)
// Top-level functions / window.* handlers are global; the AI pages run only on
// route/click (after app.js loads), so cross-file globals (GET/POST/api/state/
// escHtml/navigate/toast$/t/...) resolve at call time. No import/export.
//
// Pure relocation of the P-AI V2 multi-provider assistant: provider registry +
// fallback chain, IndexedDB conversation store, tool calling, LLM transport,
// task state machine, and the #ai-recommend / #ai-demo render surfaces + their
// ai* handlers. All script-scoped AI consts (AI_PROVIDERS/AI_TOOLS/AI_SYSTEM_PROMPT/
// TASK_*/aiTTS/...) are used only within this file; the two functions called from
// app.js (aiCallLLM, aiGetProvider) stay global and resolve cross-file.
//
// No money/order/payment/wallet/settlement/status path. No UI/behavior change.

// ═══════════════════════════════════════════════════════════════
// P-AI V2：多 provider 私有 agent — Claude/OpenAI/DeepSeek/Groq/OpenRouter/Ollama
//   + 预留 WebAZ Native (即将上线)
// ═══════════════════════════════════════════════════════════════

// Provider registry：name / desc / models / key 协议 / 请求格式 / endpoint
const AI_PROVIDERS = [
  {
    id: 'webaz',
    name: 'WebAZ Native',
    desc: '平台原生模型 · 注册即用 · 无需 API key',
    free: true,
    enabled: false,                    // 暂未上线 — 待模型 ready 后启用
    badge: '即将上线',
    keyRequired: false,
    models: [{ id: 'webaz-1', label: 'WebAZ-1 (Coming Soon)' }],
    defaultModel: 'webaz-1',
    format: 'webaz',                   // 内部协议 (TBD)
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    desc: '业内最强代理模型 · 工具调用一流 · 付费',
    free: false,
    enabled: true,
    keyRequired: true,
    keyPrefix: 'sk-ant-',
    keyHint: 'console.anthropic.com → API Keys',
    models: [
      { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7 (最强)',         vision: true },
      { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6 (均衡)',       vision: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (快/省，推荐)', vision: true },
    ],
    defaultModel: 'claude-haiku-4-5-20251001',
    endpoint: 'https://api.anthropic.com/v1/messages',
    headersFn: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }),
    format: 'anthropic',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    desc: 'GPT-5 / GPT-4o 系列 · 付费',
    free: false,
    enabled: true,
    keyRequired: true,
    keyPrefix: 'sk-',
    keyHint: 'platform.openai.com → API Keys',
    models: [
      { id: 'gpt-5',         label: 'GPT-5 (最强)',           vision: true },
      { id: 'gpt-5-mini',    label: 'GPT-5 mini (推荐)',      vision: true },
      { id: 'gpt-4o',        label: 'GPT-4o',                 vision: true },
      { id: 'gpt-4o-mini',   label: 'GPT-4o mini (经济)',     vision: true },
    ],
    defaultModel: 'gpt-5-mini',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    headersFn: (k) => ({ 'Authorization': 'Bearer ' + k }),
    format: 'openai',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    desc: 'DeepSeek V3 / R1 · 开源协议 · 极高性价比',
    free: false,
    enabled: true,
    keyRequired: true,
    keyPrefix: 'sk-',
    keyHint: 'platform.deepseek.com → API Keys',
    models: [
      { id: 'deepseek-chat',     label: 'DeepSeek V3 (聊天，推荐)' },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1 (推理强)' },
    ],
    defaultModel: 'deepseek-chat',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    headersFn: (k) => ({ 'Authorization': 'Bearer ' + k }),
    format: 'openai',
  },
  {
    id: 'qwen',
    name: '通义千问 Qwen',
    desc: '阿里 · 有开源版 (Qwen2.5/3 全家) · DashScope 兼容 OpenAI',
    free: false,
    enabled: true,
    keyRequired: true,
    keyPrefix: 'sk-',
    keyHint: 'dashscope.console.aliyun.com → API-KEY 管理',
    models: [
      { id: 'qwen-max',     label: 'Qwen-Max (旗舰)' },
      { id: 'qwen-plus',    label: 'Qwen-Plus (推荐)' },
      { id: 'qwen-turbo',   label: 'Qwen-Turbo (经济)' },
      { id: 'qwen-vl-max',  label: 'Qwen-VL-Max (视觉)', vision: true },
    ],
    defaultModel: 'qwen-plus',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    headersFn: (k) => ({ 'Authorization': 'Bearer ' + k }),
    format: 'openai',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    desc: '清华系 · GLM-4-Flash 完全免费 · 中文开发者首选',
    free: true,
    enabled: true,
    keyRequired: true,
    keyHint: 'open.bigmodel.cn → 用户中心 → API Keys',
    models: [
      { id: 'glm-4-flash', label: 'GLM-4-Flash (完全免费，推荐)' },
      { id: 'glm-4-plus',  label: 'GLM-4-Plus (旗舰，付费)' },
      { id: 'glm-4-air',   label: 'GLM-4-Air (经济)' },
      { id: 'glm-z1-air',  label: 'GLM-Z1-Air (推理)' },
    ],
    defaultModel: 'glm-4-flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    headersFn: (k) => ({ 'Authorization': 'Bearer ' + k }),
    format: 'openai',
  },
  {
    id: 'kimi',
    name: 'Kimi 月之暗面',
    desc: '长上下文之王 · 128k 稳定 · OpenAI 兼容',
    free: false,
    enabled: true,
    keyRequired: true,
    keyPrefix: 'sk-',
    keyHint: 'platform.moonshot.cn → 用户中心 → API Key',
    models: [
      { id: 'moonshot-v1-8k',   label: 'Moonshot v1 8k (经济)' },
      { id: 'moonshot-v1-32k',  label: 'Moonshot v1 32k (推荐)' },
      { id: 'moonshot-v1-128k', label: 'Moonshot v1 128k (长文)' },
    ],
    defaultModel: 'moonshot-v1-32k',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    headersFn: (k) => ({ 'Authorization': 'Bearer ' + k }),
    format: 'openai',
  },
  {
    id: 'doubao',
    name: '豆包 Doubao',
    desc: '字节 · 火山方舟 · 大厂背书 · OpenAI 兼容',
    free: false,
    enabled: true,
    keyRequired: true,
    keyHint: '火山引擎 → 方舟控制台 → API Key（注意：模型 ID 是 endpoint id 形式 ep-xxx）',
    models: [
      { id: 'doubao-pro-32k',  label: 'Doubao Pro 32k (旗舰，需替换为 ep-xxx)' },
      { id: 'doubao-pro-128k', label: 'Doubao Pro 128k (长文)' },
      { id: 'doubao-lite-32k', label: 'Doubao Lite 32k (经济)' },
    ],
    defaultModel: 'doubao-pro-32k',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    headersFn: (k) => ({ 'Authorization': 'Bearer ' + k }),
    format: 'openai',
  },
  {
    id: 'groq',
    name: 'Groq',
    desc: 'Llama / Mixtral on Groq · 免费层 + 极快推理 · 开源',
    free: true,
    enabled: true,
    keyRequired: true,
    keyPrefix: 'gsk_',
    keyHint: 'console.groq.com → API Keys (有免费层)',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (推荐)' },
      { id: 'llama-3.1-8b-instant',    label: 'Llama 3.1 8B (极快)' },
      { id: 'mixtral-8x7b-32768',      label: 'Mixtral 8x7B' },
    ],
    defaultModel: 'llama-3.3-70b-versatile',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    headersFn: (k) => ({ 'Authorization': 'Bearer ' + k }),
    format: 'openai',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    desc: '一个 key 用所有模型 · 聚合付费',
    free: false,
    enabled: true,
    keyRequired: true,
    keyPrefix: 'sk-or-',
    keyHint: 'openrouter.ai → Keys',
    models: [
      { id: 'anthropic/claude-3.5-sonnet',         label: 'Claude 3.5 Sonnet',          vision: true },
      { id: 'openai/gpt-4o',                       label: 'GPT-4o',                     vision: true },
      { id: 'meta-llama/llama-3.3-70b-instruct',   label: 'Llama 3.3 70B (开源)' },
      { id: 'google/gemini-2.0-flash-exp:free',    label: 'Gemini 2.0 Flash (免费)',    vision: true },
    ],
    defaultModel: 'anthropic/claude-3.5-sonnet',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    headersFn: (k) => ({ 'Authorization': 'Bearer ' + k, 'HTTP-Referer': location.origin, 'X-Title': 'WebAZ' }),
    format: 'openai',
  },
  {
    id: 'ollama',
    name: 'Ollama 本地',
    desc: '本机跑开源模型 · 完全离线 · 零费用 · 隐私最强',
    free: true,
    enabled: true,
    keyRequired: false,
    customEndpoint: true,
    defaultEndpoint: 'http://localhost:11434/v1/chat/completions',
    keyHint: '本地需先 `ollama serve`，默认端口 11434',
    models: [
      { id: 'llama3.2',  label: 'Llama 3.2' },
      { id: 'qwen2.5',   label: 'Qwen 2.5' },
      { id: 'mistral',   label: 'Mistral' },
      { id: 'phi3.5',    label: 'Phi 3.5' },
    ],
    defaultModel: 'llama3.2',
    format: 'openai',
    headersFn: () => ({}),
  },
  {
    id: 'custom',
    name: '自定义 (你的 agent)',
    desc: '接入你自己部署的 agent / 代理 (OpenAI 或 Anthropic 兼容协议)',
    free: true,                      // 取决于用户，UI 归免费组（自有部署多免费）
    enabled: true,
    keyRequired: false,
    keyOptional: true,
    customEndpoint: true,
    defaultEndpoint: 'https://your-agent.example.com/v1/chat/completions',
    keyHint: '填完整 endpoint URL（含 path）；如需鉴权再填 Bearer Token',
    isCustom: true,                  // 配置 modal 显示额外输入（model + format + name）
    models: [{ id: 'custom-model', label: '自定义模型' }],
    defaultModel: 'custom-model',
    format: 'openai',
    headersFn: (k) => k ? { 'Authorization': 'Bearer ' + k } : {},
  },
]

function aiGetProvider(id) {
  const p = AI_PROVIDERS.find(x => x.id === id)
  if (!p) return null
  // 自定义 provider: 用 localStorage 覆盖 name/model/format（用户在 modal 配置）
  if (p.isCustom) {
    const cName  = localStorage.getItem('webaz_ai_custom_name')   || p.name
    const cModel = localStorage.getItem('webaz_ai_custom_model')  || p.defaultModel
    const cFormat= localStorage.getItem('webaz_ai_custom_format') || p.format
    const cLabel = localStorage.getItem('webaz_ai_custom_label')  || '自定义模型'
    return {
      ...p,
      name: cName,
      format: cFormat,
      models: [{ id: cModel, label: cLabel }],
      defaultModel: cModel,
    }
  }
  return p
}

// 调用链：用户配置多个 provider 按顺序备选，第一个失败自动 fallback 到下一个
// 默认含 WebAZ（占位首位，模型 ready 后自动启用；未启用时 aiCallLLM 自动 skip）
function aiGetChain() {
  try {
    const raw = localStorage.getItem('webaz_ai_chain')
    if (raw) {
      const arr = JSON.parse(raw)
      // 保证 webaz 始终在第一位（除非用户显式移除）
      if (!arr.includes('webaz') && localStorage.getItem('webaz_ai_chain_webaz_removed') !== '1') arr.unshift('webaz')
      return arr
    }
  } catch {}
  const old = localStorage.getItem('webaz_ai_provider')
  if (old) return ['webaz', old]
  return ['webaz']  // 全新用户默认：webaz 占位 → 后续配置自动 append
}
function aiSetChain(arr) {
  localStorage.setItem('webaz_ai_chain', JSON.stringify(arr))
  if (arr.length) localStorage.setItem('webaz_ai_provider', arr[0])  // 兼容
}
function aiAddToChain(pid, asPrimary) {
  let chain = aiGetChain().filter(x => x !== pid)
  if (asPrimary) chain = [pid, ...chain]
  else chain.push(pid)
  aiSetChain(chain)
}
function aiRemoveFromChain(pid) {
  if (pid === 'webaz') localStorage.setItem('webaz_ai_chain_webaz_removed', '1')
  aiSetChain(aiGetChain().filter(x => x !== pid))
}
function aiMoveInChain(pid, direction) {
  const chain = aiGetChain()
  const i = chain.indexOf(pid)
  if (i < 0) return
  const ni = direction === 'up' ? i - 1 : i + 1
  if (ni < 0 || ni >= chain.length) return
  ;[chain[i], chain[ni]] = [chain[ni], chain[i]]
  aiSetChain(chain)
}
window.aiMoveInChain = aiMoveInChain
window.aiRemoveFromChain = aiRemoveFromChain

// 当前"实际生效"的 provider / model：chain 里第一个 enabled + 有 key 的
// 如果都不可用，回退到 chain[0]（用于配置页显示）
function aiGetActive() {
  const chain = aiGetChain()
  for (const pid of chain) {
    const p = aiGetProvider(pid)
    if (p && p.enabled && (!p.keyRequired || aiGetKey(pid))) {
      const mid = localStorage.getItem('webaz_ai_model_' + p.id) || p.defaultModel
      return { provider: p, modelId: mid }
    }
  }
  // fallback：chain[0] 或 anthropic
  const fallbackId = chain[0] || 'anthropic'
  const fp = aiGetProvider(fallbackId) || aiGetProvider('anthropic')
  return { provider: fp, modelId: localStorage.getItem('webaz_ai_model_' + fp.id) || fp.defaultModel }
}
function aiSetActive(pid, mid) {
  aiAddToChain(pid, true)  // 设为主用
  if (mid) localStorage.setItem('webaz_ai_model_' + pid, mid)
}
function aiGetKey(pid) {
  return localStorage.getItem('webaz_ai_key_' + pid)
    || (pid === 'anthropic' ? localStorage.getItem('webaz_ai_key') : null)  // 旧版兼容
}
function aiSetKey(pid, key) { localStorage.setItem('webaz_ai_key_' + pid, key) }
function aiGetEndpoint(pid) {
  const p = aiGetProvider(pid)
  if (!p) return null
  if (p.customEndpoint) return localStorage.getItem('webaz_ai_endpoint_' + pid) || p.defaultEndpoint
  return p.endpoint
}
function aiSetEndpoint(pid, url) { localStorage.setItem('webaz_ai_endpoint_' + pid, url) }

const AI_DB_NAME = 'webaz_ai_v1'
const AI_DB_VER  = 1
let _aiDb = null

function openAIDB() {
  if (_aiDb) return Promise.resolve(_aiDb)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AI_DB_NAME, AI_DB_VER)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('conversations')) {
        const s = db.createObjectStore('conversations', { keyPath: 'id' })
        s.createIndex('updated_at', 'updated_at')
      }
    }
    req.onsuccess = () => { _aiDb = req.result; resolve(_aiDb) }
    req.onerror = () => reject(req.error)
  })
}

async function aiSaveConversation(conv) {
  conv.updated_at = new Date().toISOString()
  return openAIDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction('conversations', 'readwrite')
    tx.objectStore('conversations').put(conv)
    tx.oncomplete = () => res(conv)
    tx.onerror = () => rej(tx.error)
  }))
}

async function aiListConversations() {
  return openAIDB().then(db => new Promise((res) => {
    const list = []
    db.transaction('conversations').objectStore('conversations').index('updated_at').openCursor(null, 'prev').onsuccess = (e) => {
      const c = e.target.result
      if (c) { list.push(c.value); c.continue() }
      else res(list)
    }
  }))
}

async function aiGetConversation(id) {
  return openAIDB().then(db => new Promise((res, rej) => {
    const r = db.transaction('conversations').objectStore('conversations').get(id)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  }))
}

async function aiDeleteConversation(id) {
  return openAIDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction('conversations', 'readwrite')
    tx.objectStore('conversations').delete(id)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  }))
}

const AI_TOOLS = [
  {
    name: 'search_products',
    description: '在 WebAZ 平台搜索商品。自动按当前用户的默认配送地址过滤不可达商品。返回前 10 个匹配商品（含 id/title/price/seller/stock/sales_count/commission_rate）。',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词（如商品名）' },
        max_price: { type: 'number', description: '最高价格 WAZ' },
        has_sales: { type: 'string', enum: ['true', 'false'], description: 'true=只看已成交的(真实验证好物); false=只看新品(未成交)' },
      },
    },
  },
  {
    name: 'get_product_detail',
    description: '获取单个商品的完整详情（描述/库存/卖家/退换货政策/质保）。',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string' } },
      required: ['product_id'],
    },
  },
  {
    name: 'search_nearby',
    description: '获取附近（约 11km 范围）匿名聚合购买活跃度（k-anonymity ≥ 3 隐私保护）。返回 24h/7d 活跃数 + 热门商品 + 热门类目。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_by_anchor',
    description: '按创作者"流量口令"查找评测内容（如某创作者的口令）。返回外链评测（YouTube/TikTok/etc）+ 原生 P2P 评测。',
    input_schema: {
      type: 'object',
      properties: { anchor: { type: 'string', description: '创作者的口令字符串' } },
      required: ['anchor'],
    },
  },
  {
    name: 'get_my_profile',
    description: '获取用户自己的资料（钱包余额、累计赚取、地区、默认配送地址、bio、口令）。用于个性化推荐。',
    input_schema: { type: 'object', properties: {} },
  },
]

async function aiExecTool(name, input) {
  try {
    switch (name) {
      case 'search_products': {
        const params = new URLSearchParams()
        if (input.q) params.set('q', input.q)
        if (input.max_price != null) params.set('max_price', input.max_price)
        if (input.has_sales) params.set('has_sales', input.has_sales)
        const shipTo = state.profileMini?.default_address_region
        if (shipTo) params.set('ship_to', shipTo)
        const r = await GET('/products' + (params.toString() ? '?' + params : ''))
        const list = Array.isArray(r) ? r : []
        const trimmed = list.slice(0, 10).map(p => ({
          id: p.id, title: p.title, price: p.price, seller: p.seller_name,
          stock: p.stock, sales_count: p.sales_count, commission_rate: p.commission_rate,
          category: p.category, rep_level: p.rep_level,
        }))
        return { count: trimmed.length, ship_to_filter: shipTo || null, products: trimmed }
      }
      case 'get_product_detail': {
        const r = await GET('/products/' + input.product_id)
        if (r.error) return r
        return {
          id: r.id, title: r.title, description: r.description, price: r.price,
          stock: r.stock, seller: r.seller_name, commission_rate: r.commission_rate,
          ship_regions: r.ship_regions, brand: r.brand, model: r.model,
          return_days: r.return_days, warranty_days: r.warranty_days,
        }
      }
      case 'search_nearby':
        return await GET('/nearby')
      case 'search_by_anchor': {
        const enc = encodeURIComponent(input.anchor)
        const [s, m] = await Promise.all([
          GET('/shareables/by-anchor/' + enc).catch(() => ({ shareables: [] })),
          GET('/manifests/by-anchor/' + enc).catch(() => ({ manifests: [] })),
        ])
        return {
          anchor: input.anchor,
          shareables: (s.shareables || []).map(x => ({ id: x.id, title: x.title, platform: x.external_platform, url: x.external_url, owner: x.owner_name })),
          manifests: (m.manifests || []).map(x => ({ hash: x.hash, title: x.title, type: x.content_type, owner: x.owner_name })),
        }
      }
      case 'get_my_profile': {
        const r = await GET('/profile')
        if (r.error) return r
        return {
          name: r.name, role: r.role, region: r.region,
          wallet_balance: r.wallet?.balance, wallet_earned: r.wallet?.earned,
          default_address: r.default_address_text, default_address_region: r.default_address_region,
          bio: r.bio, search_anchor: r.search_anchor,
        }
      }
    }
    return { error: 'unknown tool: ' + name }
  } catch (e) {
    return { error: (e && e.message) || String(e) }
  }
}

const AI_SYSTEM_PROMPT = `你是 WebAZ 用户的私人购物助手 agent。帮用户在 WebAZ 平台找合适的商品、了解附近购买趋势、查询创作者评测。

WebAZ 是去中心化商业协议（agent 电商 + 社交电商，不是平台电商）：
- 用 WAZ 代币交易
- 平台不主动推送，所有发现都是用户拉取的
- 创作者用"流量口令"从 TikTok/小红书 引流回 WebAZ
- "雷达扫描"匿名聚合附近购买趋势（k≥3 守护）
- 商品有真实成交验证（"被买过的好物"）

工作原则：
1. 优先理解用户需求，必要时简短反问澄清（不要冗长）
2. 主动调用工具收集信息，不要凭空臆测
3. 推荐商品时给清晰对比（价格/卖家/已售/库存）
4. 使用 **粗体** 突出重点；用 markdown 列表
5. 推荐具体商品时**附带商品 ID 完整路径** \`#order-product/prd_xxx\`，让用户点击直接跳转下单
6. V1 只读：你不能直接下单。找到合适商品后告诉用户点击链接去下单
7. 回答简洁有重点，避免长篇大论`

// 格式适配：anthropic ↔ openai
// Anthropic 内部协议: messages = [{role, content: string | [{type:'text'|'tool_use'|'tool_result', ...}]}]
// OpenAI 协议:     messages = [{role:'system'|'user'|'assistant'|'tool', content, tool_call_id?, tool_calls?}]
function aiToolsToOpenAI(anthropicTools) {
  return anthropicTools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } },
  }))
}
function aiMessagesToOpenAI(messages, system) {
  const out = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content })
      } else if (Array.isArray(m.content)) {
        // 区分两种 array content：① tool_result 走 role:tool ② text+image 走多模态 content array
        const toolResults = m.content.filter(c => c.type === 'tool_result')
        const visionParts = m.content.filter(c => c.type === 'text' || c.type === 'image')
        if (visionParts.length > 0) {
          // OpenAI 多模态：content: [{type:'text',...}, {type:'image_url', image_url:{url: 'data:...'}}]
          const oaParts = visionParts.map(c => {
            if (c.type === 'text') return { type: 'text', text: c.text }
            if (c.type === 'image' && c.source?.type === 'base64') {
              return { type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } }
            }
            return null
          }).filter(Boolean)
          out.push({ role: 'user', content: oaParts })
        }
        for (const c of toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: c.tool_use_id,
            content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
          })
        }
      }
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.content)) {
        const textPart = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
        const toolCalls = m.content.filter(c => c.type === 'tool_use').map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
        }))
        const oa = { role: 'assistant', content: textPart || null }
        if (toolCalls.length) oa.tool_calls = toolCalls
        out.push(oa)
      } else if (typeof m.content === 'string') {
        out.push({ role: 'assistant', content: m.content })
      }
    }
  }
  return out
}
function aiAdaptOpenAIResponse(oaiRes) {
  const msg = oaiRes.choices?.[0]?.message
  if (!msg) return { content: [], stop_reason: 'end_turn' }
  const content = []
  if (msg.content) content.push({ type: 'text', text: msg.content })
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {}
      try { input = JSON.parse(tc.function?.arguments || '{}') } catch {}
      content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input })
    }
  }
  const finish = oaiRes.choices[0].finish_reason
  return { content, stop_reason: finish === 'tool_calls' ? 'tool_use' : 'end_turn' }
}

// 单 provider 调用（无 fallback）
async function aiCallOneProvider(provider, opts) {
  const { messages, system, tools, max_tokens = 4096 } = opts
  if (!provider.enabled) throw new Error(`${provider.name} ${t('暂未上线')}`)
  if (provider.id === 'webaz') throw new Error(t('WebAZ Native 模型即将上线，请先选择其他 provider'))

  const apiKey = aiGetKey(provider.id)
  if (provider.keyRequired && !apiKey) throw new Error(`${t('未配置')} ${provider.name} ${t('的 API key')}`)
  const endpoint = aiGetEndpoint(provider.id)
  if (!endpoint) throw new Error(t('未配置 endpoint'))

  const modelId = localStorage.getItem('webaz_ai_model_' + provider.id) || provider.defaultModel

  let body, headers
  if (provider.format === 'anthropic') {
    body = { model: modelId, max_tokens, system, tools, messages }
    headers = { 'Content-Type': 'application/json', ...provider.headersFn(apiKey) }
  } else {
    const oaMsgs = aiMessagesToOpenAI(messages, system)
    const oaTools = tools && tools.length ? aiToolsToOpenAI(tools) : undefined
    body = { model: modelId, messages: oaMsgs, max_tokens }
    if (oaTools) { body.tools = oaTools; body.tool_choice = 'auto' }
    headers = { 'Content-Type': 'application/json', ...provider.headersFn(apiKey) }
  }

  // 启用 SSE 流式（onDelta 提供 + provider 不是 webaz → 流式；Anthropic / OpenAI 双格式各自解析）
  const useStream = typeof opts.onDelta === 'function'
  if (useStream) body.stream = true

  const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!r.ok) {
    let txt = ''
    try { txt = await r.text() } catch {}
    throw new Error(`${provider.name} API ${r.status}: ${txt.slice(0, 240)}`)
  }
  if (!useStream) {
    const raw = await r.json()
    return provider.format === 'anthropic' ? raw : aiAdaptOpenAIResponse(raw)
  }
  return await aiParseStream(r, provider.format, opts.onDelta)
}

// 解析 SSE 流，按需 onDelta(textChunk)；累积所有 content 块返回与非流式同构 { content, stop_reason }
async function aiParseStream(response, format, onDelta) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const textBlocks = []        // [{ index, text }]
  const toolBlocks = new Map() // index → { id, name, input(JSON string) }
  let stopReason = 'end_turn'

  const flush = () => {
    while (true) {
      // SSE 事件用空行分隔（\n\n）
      const i = buf.indexOf('\n\n')
      if (i < 0) return
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      handleSSEEvent(chunk)
    }
  }
  const handleSSEEvent = (chunk) => {
    let eventName = null
    const dataLines = []
    for (const ln of chunk.split('\n')) {
      if (ln.startsWith('event:')) eventName = ln.slice(6).trim()
      else if (ln.startsWith('data:')) dataLines.push(ln.slice(5).trim())
    }
    const data = dataLines.join('\n')
    if (!data) return
    if (data === '[DONE]') { stopReason = stopReason || 'end_turn'; return }
    let json; try { json = JSON.parse(data) } catch { return }

    if (format === 'anthropic') {
      const type = json.type || eventName
      if (type === 'content_block_start') {
        const idx = json.index, cb = json.content_block
        if (cb?.type === 'text')     textBlocks.push({ index: idx, text: '' })
        if (cb?.type === 'tool_use') toolBlocks.set(idx, { id: cb.id, name: cb.name, input: '' })
      } else if (type === 'content_block_delta') {
        const idx = json.index, d = json.delta
        if (d?.type === 'text_delta') {
          const b = textBlocks.find(x => x.index === idx); if (b) { b.text += d.text; onDelta(d.text) }
        } else if (d?.type === 'input_json_delta') {
          const tb = toolBlocks.get(idx); if (tb) tb.input += (d.partial_json || '')
        }
      } else if (type === 'message_delta') {
        if (json.delta?.stop_reason) stopReason = json.delta.stop_reason
      }
    } else {
      // OpenAI: data 每条形如 {choices:[{delta:{content, tool_calls}, finish_reason}]}
      const ch = json.choices?.[0]; if (!ch) return
      const delta = ch.delta || {}
      if (typeof delta.content === 'string' && delta.content) {
        let b = textBlocks[0]
        if (!b) { b = { index: 0, text: '' }; textBlocks.push(b) }
        b.text += delta.content
        onDelta(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          let tb = toolBlocks.get(idx)
          if (!tb) { tb = { id: tc.id || '', name: '', input: '' }; toolBlocks.set(idx, tb) }
          if (tc.id) tb.id = tc.id
          if (tc.function?.name) tb.name = tc.function.name
          if (tc.function?.arguments) tb.input += tc.function.arguments
        }
      }
      if (ch.finish_reason) {
        stopReason = ch.finish_reason === 'tool_calls' ? 'tool_use' : ch.finish_reason
      }
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    flush()
  }
  // 末尾残留
  buf += decoder.decode()
  if (buf.length) { handleSSEEvent(buf); buf = '' }

  // 组装成与非流式同构的 content 数组
  const content = []
  for (const b of textBlocks) if (b.text) content.push({ type: 'text', text: b.text })
  for (const tb of toolBlocks.values()) {
    let input = {}
    try { input = tb.input ? JSON.parse(tb.input) : {} } catch {}
    content.push({ type: 'tool_use', id: tb.id, name: tb.name, input })
  }
  return { content, stop_reason: stopReason }
}

// 调用链：按顺序尝试 chain；某 provider 失败 → toast 提示后尝试下一个
async function aiCallLLM(opts) {
  const chain = aiGetChain()
  if (chain.length === 0) throw new Error(t('未配置任何 AI provider，请先去设置页选择'))
  let lastErr = null
  for (let i = 0; i < chain.length; i++) {
    const pid = chain[i]
    const p = aiGetProvider(pid)
    if (!p || !p.enabled) continue
    if (p.keyRequired && !aiGetKey(pid)) continue
    try {
      const result = await aiCallOneProvider(p, opts)
      // 成功后，若之前 fallback 过，提示用户
      if (i > 0) toast$(t('主用失败，已切到备选 ') + p.name, 'info')
      return result
    } catch (e) {
      lastErr = e
      console.warn(`[AI] ${p.name} failed:`, e.message)
      // 如果还有 fallback，继续；否则抛
      if (i < chain.length - 1) {
        const nextP = aiGetProvider(chain[i + 1])
        if (nextP) toast$(`⚠ ${p.name} ${t('失败，尝试备选')} ${nextP.name}…`, 'info')
      }
    }
  }
  throw lastErr || new Error(t('调用链全部失败'))
}

// 任务状态机：用户给需求 → AI 出方案 → 用户审核 → AI 执行 → 用户评价
const TASK_STATES = {
  intent:    { label: '提需求',  short: '提需求',  color: '#6b7280' },
  planning:  { label: '出方案',  short: '出方案',  color: '#3b82f6' },
  review:    { label: '审核',    short: '审核',    color: '#f59e0b' },
  executing: { label: '执行中',  short: '执行',    color: '#7c3aed' },
  results:   { label: '看结果',  short: '结果',    color: '#06b6d4' },
  completed: { label: '已完成',  short: '完成',    color: '#16a34a' },
  cancelled: { label: '已取消',  short: '取消',    color: '#dc2626' },
}
const TASK_FLOW = ['intent', 'planning', 'review', 'executing', 'results', 'completed']

function aiInitTask(conv) {
  if (!conv.task) conv.task = { state: 'intent', plan: null, results: null, rating: null, feedback: null, decision_history: [] }
  return conv.task
}

function aiExtractText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text).join('\n\n').trim()
  return ''
}

// 按任务状态给 system prompt 加增强指令
function aiSystemForState(state) {
  const base = AI_SYSTEM_PROMPT
  if (state === 'planning') {
    return base + `\n\n[任务规划阶段]\n用户给了你一个任务。请先**制定执行方案**（不要立即调用工具、不要直接给推荐）：\n- 用 markdown 编号列表列出 3-5 个执行步骤\n- 每步说明会用什么工具、收集什么信息\n- 最后用一行总结预期产出\n\n方案结束后停止输出，等用户审核批准。`
  }
  if (state === 'executing') {
    return base + `\n\n[执行阶段]\n用户已批准方案，请按方案调用工具执行。完成后给出**清晰的最终结果**（推荐商品/汇总信息），结构化呈现。`
  }
  if (state === 'completed' || state === 'results') {
    return base + `\n\n[追问阶段]\n任务主流程已完成。用户在追问或细化，简洁直接回答。`
  }
  return base
}

// TTS：朗读 AI 回话（speechSynthesis 浏览器原生，无 cost）
const aiTTS = {
  isEnabled() { return localStorage.getItem('webaz_ai_tts_enabled') === '1' },
  setEnabled(v) { localStorage.setItem('webaz_ai_tts_enabled', v ? '1' : '0') },
  supported() { return typeof window !== 'undefined' && 'speechSynthesis' in window },
  stop() { try { window.speechSynthesis?.cancel() } catch {} },
  speak(text) {
    if (!this.supported() || !this.isEnabled()) return
    const t = String(text || '').trim()
    if (!t) return
    // 清理 markdown / 表情包 / code 块，留可读纯文本
    const clean = t
      .replace(/```[\s\S]*?```/g, '')                     // code blocks
      .replace(/`[^`]+`/g, '')                            // inline code
      .replace(/!\[.*?\]\(.*?\)/g, '')                    // images
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')           // links → text only
      .replace(/[*_#>~|]/g, '')                           // markdown markup
      .slice(0, 800)                                      // 防超长一直播
    this.stop()
    const u = new SpeechSynthesisUtterance(clean)
    u.lang = window._lang === 'en' ? 'en-US' : 'zh-CN'
    u.rate = 1.0
    u.pitch = 1.0
    try { window.speechSynthesis.speak(u) } catch {}
  },
}

window.aiToggleTTS = () => {
  const next = !aiTTS.isEnabled()
  aiTTS.setEnabled(next)
  if (!next) aiTTS.stop()
  // 重渲状态栏 chip
  const cur = state.aiCurrentConv
  if (cur && location.hash.startsWith('#ai-recommend') && !location.hash.includes('config') && !location.hash.includes('tasks')) {
    renderAIRecommend(document.getElementById('app'))
  }
}

// 当前 chain 首个可用 provider 的 active model 是否支持视觉？
function aiCurrentModelSupportsVision() {
  const chain = aiGetChain()
  for (const pid of chain) {
    const p = aiGetProvider(pid)
    if (!p || !p.enabled) continue
    if (p.keyRequired && !aiGetKey(pid)) continue
    const modelId = localStorage.getItem('webaz_ai_model_' + pid) || p.defaultModel
    const m = p.models.find(x => x.id === modelId)
    return !!m?.vision
  }
  return false
}

// 把 dataURL 拆 mime + base64
function aiParseDataURL(dataURL) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataURL || '')
  return m ? { mime: m[1], data: m[2] } : null
}

async function aiChatTurn(conversation, userText, attachments, onProgress) {
  // 向后兼容旧签名：aiChatTurn(conv, text, onProgress)
  if (typeof attachments === 'function' && !onProgress) {
    onProgress = attachments
    attachments = []
  }
  attachments = attachments || []
  const task = aiInitTask(conversation)
  // 状态推进：intent → planning（用户首次输入）
  if (task.state === 'intent') task.state = 'planning'
  const titleSeed = typeof userText === 'string' ? userText : ''
  if (!conversation.title && titleSeed) conversation.title = titleSeed.slice(0, 24)

  // 构造 user content：纯文本 / 含视觉附件 → anthropic 风格 content array
  // （aiMessagesToOpenAI 会把它翻译成 OpenAI image_url 形式）
  const visionAttachments = attachments.filter(a => a.kind === 'image')
  if (visionAttachments.length > 0 && aiCurrentModelSupportsVision()) {
    const content = []
    if (userText) content.push({ type: 'text', text: userText })
    for (const a of visionAttachments) {
      const p = aiParseDataURL(a.dataURL)
      if (p) content.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } })
    }
    conversation.messages.push({ role: 'user', content })
  } else {
    conversation.messages.push({ role: 'user', content: userText })
  }

  let iters = 0
  const MAX_ITERS = 8
  // planning 阶段：禁用工具调用，强制只出方案
  const tools = task.state === 'planning' ? [] : AI_TOOLS
  while (iters++ < MAX_ITERS) {
    onProgress?.('thinking', iters)
    // 流式：每个 text token 上报 'text' chunk
    const onTextDelta = (chunk) => onProgress?.('text', chunk)
    const res = await aiCallLLM({ messages: conversation.messages, system: aiSystemForState(task.state), tools, onDelta: onTextDelta })
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error))
    conversation.messages.push({ role: 'assistant', content: res.content })
    const toolUses = (res.content || []).filter(c => c.type === 'tool_use')
    if (toolUses.length === 0 || res.stop_reason !== 'tool_use') {
      // 状态收尾：planning 完成 → review；executing 完成 → results
      if (task.state === 'planning')  { task.plan    = aiExtractText(res.content); task.state = 'review'  }
      if (task.state === 'executing') { task.results = aiExtractText(res.content); task.state = 'results' }
      await aiSaveConversation(conversation)
      return res
    }
    onProgress?.('tool_use', toolUses.map(t => t.name))
    // 实时 trace：让 UI 拿到完整 tool 对象（含 id/name/input），先渲染 ⏳ 卡
    onProgress?.('tool_use_start', toolUses)
    const toolResults = await Promise.all(toolUses.map(async tu => {
      const content = JSON.stringify(await aiExecTool(tu.name, tu.input))
      // 每个 tool 落地即 ping UI 切到 ✅
      onProgress?.('tool_result_one', { id: tu.id, name: tu.name, input: tu.input, content })
      return { type: 'tool_result', tool_use_id: tu.id, content }
    }))
    conversation.messages.push({ role: 'user', content: toolResults })
  }
  await aiSaveConversation(conversation)
  return { content: [{ type: 'text', text: '⚠️ 达到工具调用上限，请重新提问或细化问题。' }] }
}

function aiCreateConversation() {
  return {
    id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    title: null,
    messages: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function renderAIMarkdown(text) {
  if (!text) return ''
  let html = escHtml(text)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:11px">$1</code>')
  html = html.replace(/\n/g, '<br>')
  // 自动 #order-product/prd_xxx 链接
  html = html.replace(/#order-product\/(prd_[A-Za-z0-9_]+)/g, '<a href="#order-product/$1" style="color:#4f46e5;font-weight:600">#order-product/$1</a>')
  html = html.replace(/(?<![\/\w])(prd_[A-Za-z0-9_]+)/g, '<a href="#order-product/$1" style="color:#4f46e5">$1</a>')
  return html
}

// 渲染单个 tool_use 卡（含可选的配对 tool_result 展开）
function renderToolCard(toolUse, resultPreview) {
  const params = toolUse.input ? JSON.stringify(toolUse.input, null, 2) : '{}'
  const paramsShort = params.length > 80 ? params.slice(0, 78) + '…' : params
  const hasResult = resultPreview != null
  let resultText = ''
  if (hasResult) {
    try {
      const parsed = typeof resultPreview === 'string' ? JSON.parse(resultPreview) : resultPreview
      resultText = JSON.stringify(parsed, null, 2)
    } catch { resultText = String(resultPreview) }
  }
  const resultShort = resultText.length > 240 ? resultText.slice(0, 240) + '…' : resultText
  const statusEmoji = hasResult ? '✅' : '⏳'
  const statusColor = hasResult ? '#16a34a' : '#f59e0b'
  return `<details style="margin:6px 0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    <summary style="cursor:pointer;padding:6px 10px;font-size:11px;display:flex;align-items:center;gap:6px;list-style:none;user-select:none">
      <span style="color:${statusColor}">${statusEmoji}</span>
      <span style="font-family:ui-monospace,Consolas,monospace;color:#3730a3;font-weight:600">${escHtml(toolUse.name || '')}</span>
      <span style="color:#9ca3af;font-family:ui-monospace,Consolas,monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px">${escHtml(paramsShort.replace(/\n\s*/g, ' '))}</span>
      <span style="color:#9ca3af;font-size:10px">▾</span>
    </summary>
    <div style="padding:6px 10px;border-top:1px solid #f3f4f6;background:#f9fafb">
      <div style="font-size:10px;color:#6b7280;margin-bottom:3px">${t('参数')}</div>
      <pre style="margin:0 0 8px;font-size:11px;font-family:ui-monospace,Consolas,monospace;color:#374151;white-space:pre-wrap;word-wrap:break-word">${escHtml(params)}</pre>
      ${hasResult ? `
        <div style="font-size:10px;color:#6b7280;margin-bottom:3px">${t('返回')}</div>
        <pre style="margin:0;font-size:11px;font-family:ui-monospace,Consolas,monospace;color:#374151;white-space:pre-wrap;word-wrap:break-word;max-height:240px;overflow:auto">${escHtml(resultShort)}</pre>
      ` : `<div style="font-size:11px;color:#92400e;font-style:italic">${t('执行中…')}</div>`}
    </div>
  </details>`
}

function renderAIMessages(messages) {
  if (!messages || messages.length === 0) {
    return `<div style="text-align:center;padding:30px 14px;color:#9ca3af">
      <div style="font-size:36px;margin-bottom:10px">🤖</div>
      <div style="font-size:13px;margin-bottom:8px">${t('你的私有 agent 已就绪')}</div>
      <div style="font-size:11px;line-height:1.8;margin-bottom:14px">
        ${t('试试问：')}<br>
        • ${t('"帮我找适合送 60 岁妈妈的礼物 ≤ 500 元"')}<br>
        • ${t('"附近最近有人买什么？"')}<br>
        • ${t('"某个口令的创作者发了啥？"')}
      </div>
      <a href="#ai-demo" style="display:inline-block;font-size:12px;color:#007aff;text-decoration:none;background:#eff6ff;border:0.5px solid #bfdbfe;padding:6px 14px;border-radius:99px">🎬 ${t('看看预设演示 →')}</a>
    </div>`
  }
  // 预扫所有 tool_result 建索引，渲染 tool_use 时按 id 配对
  const toolResults = {}
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'tool_result') toolResults[c.tool_use_id] = c.content
      }
    }
  }
  return messages.map(m => {
    if (m.role === 'user' && typeof m.content === 'string') {
      return `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <div style="background:#4f46e5;color:#fff;border-radius:10px 10px 2px 10px;padding:8px 12px;max-width:80%;white-space:pre-wrap;word-wrap:break-word">${escHtml(m.content)}</div>
      </div>`
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      // 区分：① text/image 多模态用户消息 ② tool_result 隐藏
      const visionParts = m.content.filter(c => c.type === 'text' || c.type === 'image')
      if (visionParts.length === 0) return ''   // 纯 tool_result，UI 隐藏
      const blocks = visionParts.map(c => {
        if (c.type === 'text') return `<div style="white-space:pre-wrap;word-wrap:break-word">${escHtml(c.text)}</div>`
        if (c.type === 'image' && c.source?.type === 'base64') {
          // L-2: media_type / data 都做严格白名单后再拼 attribute，避免越界字符引号注入
          const mime = String(c.source.media_type || '').match(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/) ? c.source.media_type : 'image/png'
          const data = String(c.source.data || '').replace(/[^A-Za-z0-9+/=]/g, '')
          const url = `data:${mime};base64,${data}`
          return `<img src="${url}" style="max-width:240px;max-height:240px;border-radius:6px;margin-top:6px;display:block">`
        }
        return ''
      }).join('')
      return `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <div style="background:#4f46e5;color:#fff;border-radius:10px 10px 2px 10px;padding:8px 12px;max-width:80%">${blocks}</div>
      </div>`
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const blocks = m.content.map(c => {
        if (c.type === 'text') return `<div>${renderAIMarkdown(c.text)}</div>`
        if (c.type === 'tool_use') return renderToolCard(c, toolResults[c.id])
        return ''
      }).join('')
      if (!blocks.trim()) return ''
      return `<div style="display:flex;justify-content:flex-start;margin-bottom:10px">
        <div style="background:#f3f4f6;color:#111827;border-radius:10px 10px 10px 2px;padding:8px 12px;max-width:90%;word-wrap:break-word">${blocks}</div>
      </div>`
    }
    return ''
  }).join('')
}

function aiProviderHasKey(p) {
  if (!p.keyRequired) return true
  return !!aiGetKey(p.id)
}

function renderAIProviderCard(p, opts = {}) {
  if (!p) return ''
  const isActive = opts.active
  const hasKey = aiProviderHasKey(p)
  const disabled = !p.enabled
  const chain = aiGetChain()
  const inChain = chain.includes(p.id)
  const chainIdx = chain.indexOf(p.id)
  const isPrimary = chainIdx === 0
  const freeChip = p.free ? `<span style="background:#dcfce7;color:#15803d;font-size:9px;padding:1px 6px;border-radius:99px;font-weight:600">${t('免费')}</span>` : `<span style="background:#fef3c7;color:#92400e;font-size:9px;padding:1px 6px;border-radius:99px;font-weight:600">${t('付费')}</span>`
  const badge = p.badge ? `<span style="background:#fde68a;color:#92400e;font-size:9px;padding:1px 6px;border-radius:99px;font-weight:600">${t(p.badge)}</span>` : ''
  const statusChip = !p.enabled
    ? `<span style="color:#9ca3af;font-size:10px">${t('暂未上线')}</span>`
    : isPrimary
      ? `<span style="color:#4f46e5;font-size:10px;font-weight:600">🟣 ${t('主用')}</span>`
      : inChain
        ? `<span style="color:#0891b2;font-size:10px">⚪ ${t('备选')} ${chainIdx}</span>`
        : hasKey
          ? `<span style="color:#059669;font-size:10px">✓ ${t('已配置')}</span>`
          : `<span style="color:#d97706;font-size:10px">⚠ ${t('未配 key')}</span>`
  return `<div onclick="${disabled ? '' : `aiOpenProviderConfig('${p.id}')`}"
    style="
      background:${isPrimary ? 'linear-gradient(135deg,#eef2ff,#faf5ff)' : inChain ? '#f0fdfa' : '#fff'};
      border:1px solid ${isPrimary ? '#a5b4fc' : inChain ? '#a7f3d0' : '#e5e7eb'};
      border-radius:10px;padding:12px;cursor:${disabled ? 'not-allowed' : 'pointer'};
      opacity:${disabled ? '0.55' : '1'};
      ${opts.fullWidth ? 'width:100%' : ''}
      transition:transform 0.1s ease;
    ">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px">
      <div style="font-size:13px;font-weight:600;color:#111827">${escHtml(p.name)}</div>
      <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end">${badge}${freeChip}</div>
    </div>
    <div style="font-size:11px;color:#6b7280;line-height:1.4;margin-bottom:6px">${t(p.desc)}</div>
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:10px;color:#9ca3af">${p.models.length} ${t('个模型')}</div>
      ${statusChip}
    </div>
  </div>`
}

// 状态栏：显示当前模型 + 付费/免费 + 视觉能力 + 任务/配置入口
function renderAIStatusBar() {
  const { provider, modelId } = aiGetActive()
  const curModel = provider.models.find(m => m.id === modelId) || provider.models[0]
  const isFree = provider.free
  const isWebaz = provider.id === 'webaz'
  const visionChip = curModel?.vision
    ? `<span title="${t('当前模型可识图')}" style="background:#eef2ff;color:#3730a3;font-size:9px;padding:2px 6px;border-radius:99px;font-weight:600;flex-shrink:0">👁 ${t('视觉')}</span>`
    : ''
  const dot = isWebaz ? '#fbbf24' : (aiProviderHasKey(provider) && provider.enabled ? '#10b981' : '#dc2626')
  return `<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(135deg,#fafafa,#f3f4f6);border:1px solid #e5e7eb;border-radius:10px;margin-bottom:10px;flex-wrap:wrap">
    <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dot};flex-shrink:0"></span>
      <span style="background:${isFree ? '#dcfce7' : '#fef3c7'};color:${isFree ? '#15803d' : '#92400e'};font-size:9px;padding:2px 6px;border-radius:99px;font-weight:600;flex-shrink:0">${t(isFree ? '免费' : '付费')}</span>
      ${visionChip}
      <span style="font-weight:600;font-size:13px;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(provider.name)}</span>
      <span style="color:#d1d5db;font-size:11px;flex-shrink:0">·</span>
      <span style="color:#6b7280;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(curModel?.label || modelId)}</span>
    </div>
    ${aiTTS.supported() ? `
    <button onclick="aiToggleTTS()" title="${aiTTS.isEnabled() ? t('点击关闭朗读') : t('点击开启朗读 AI 回话')}"
      style="background:${aiTTS.isEnabled() ? '#eef2ff' : 'none'};border:1px solid ${aiTTS.isEnabled() ? '#4f46e5' : '#e5e7eb'};border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;color:${aiTTS.isEnabled() ? '#4f46e5' : '#6b7280'};flex-shrink:0">🔊</button>
    ` : ''}
    <button onclick="navigate('#ai-recommend/tasks')" title="${t('任务管理')}" style="background:none;border:1px solid #e5e7eb;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;color:#6b7280;flex-shrink:0">📋</button>
    <button onclick="navigate('#ai-recommend/config')" title="${t('AI 配置')}" style="background:none;border:1px solid #e5e7eb;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;color:#6b7280;flex-shrink:0">⚙️</button>
  </div>`
}

// 任务流程 stepper：6 阶段 + 当前态高亮
function renderTaskStepper(task) {
  if (task.state === 'cancelled') {
    return `<div style="background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;color:#991b1b;margin-bottom:10px">⊘ ${t('任务已取消')}</div>`
  }
  const curIdx = TASK_FLOW.indexOf(task.state)
  return `<div style="display:flex;align-items:center;gap:2px;margin-bottom:10px;font-size:10px;padding:6px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow-x:auto;scrollbar-width:none">
    ${TASK_FLOW.map((s, i) => {
      const st = TASK_STATES[s]
      const done = i < curIdx
      const active = i === curIdx
      return `<div style="display:flex;align-items:center;gap:3px;flex-shrink:0">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:9px;background:${done ? '#16a34a' : active ? st.color : '#e5e7eb'};color:${done || active ? '#fff' : '#9ca3af'};font-weight:${active ? '700' : '500'}">${done ? '✓' : i + 1}</span>
        <span style="color:${active ? st.color : done ? '#6b7280' : '#9ca3af'};font-weight:${active ? '600' : '400'};white-space:nowrap">${t(st.short)}</span>
        ${i < TASK_FLOW.length - 1 ? `<span style="color:#d1d5db;margin:0 1px">→</span>` : ''}
      </div>`
    }).join('')}
  </div>`
}

// 当前任务状态下的可操作按钮（批准/改方案/取消 等）
function renderTaskActions(task) {
  if (task.state === 'review' && task.plan) {
    return `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;margin-top:8px">
      <div style="font-size:11px;color:#92400e;font-weight:600;margin-bottom:6px">📋 ${t('AI 已出方案 — 请审核：')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" style="width:auto;padding:6px 14px;font-size:12px;background:#16a34a;border-color:#16a34a" onclick="aiApprovePlan()">✓ ${t('批准执行')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto;padding:6px 14px;font-size:12px" onclick="aiRequestModify()">✎ ${t('改方案')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto;padding:6px 14px;font-size:12px;color:#dc2626;border-color:#fca5a5" onclick="aiCancelTask()">⊘ ${t('取消任务')}</button>
      </div>
    </div>`
  }
  if (task.state === 'results' && task.results) {
    return `<div style="background:#ecfdf5;border:1px solid #bbf7d0;border-radius:8px;padding:10px 12px;margin-top:8px">
      <div style="font-size:11px;color:#15803d;font-weight:600;margin-bottom:6px">✅ ${t('AI 已返回结果 — 确认并评价：')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" style="width:auto;padding:6px 14px;font-size:12px" onclick="aiOpenRateModal()">⭐ ${t('完成并评价')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto;padding:6px 14px;font-size:12px" onclick="aiRequestRedo()">↻ ${t('要求重做')}</button>
      </div>
    </div>`
  }
  if (task.state === 'completed' && task.rating != null) {
    return `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:8px 12px;margin-top:8px;font-size:11px;color:#0c4a6e">
      🎉 ${t('任务已完成')} · ${'⭐'.repeat(task.rating)}${task.feedback ? ' · ' + escHtml(task.feedback).slice(0, 50) : ''}
      <button onclick="aiNewConv()" style="background:none;border:none;color:#0284c7;font-size:11px;cursor:pointer;margin-left:6px;text-decoration:underline">${t('开新任务')}</button>
    </div>`
  }
  return ''
}

function aiInputPlaceholder(task) {
  switch (task.state) {
    case 'intent':    return t('告诉我你想做的事…例如：帮我找适合 60 岁妈妈的礼物 ≤ 500 WAZ')
    case 'planning':  return t('AI 在思考方案，请稍候…')
    case 'review':    return t('补充或调整方案要求（可选）')
    case 'executing': return t('AI 在执行，请稍候…')
    case 'results':   return t('追问 / 细化（可选）')
    case 'completed': return t('继续追问或点上方"开新任务"')
    default:          return t('问问你的 agent...')
  }
}

// 任务快速模板（intent 阶段显示）— 让用户一键启动常见 agent 场景
const AI_QUICK_TEMPLATES = [
  { icon: '🎁', label: '找礼物',   prompt: '帮我找一个适合 [对象/年龄] 的礼物，预算 [金额] WAZ，要 [风格/品类] 类型' },
  { icon: '🔍', label: '比价',     prompt: '帮我比较 [商品名/链接]，找 WebAZ 上的最优价' },
  { icon: '⭐', label: '挑信誉',   prompt: '推荐 3 个 [品类] 商品，优先 trusted+ 卖家 + 高完成率' },
  { icon: '🚚', label: '看物流',   prompt: '我在 [地区]，哪些 [品类] 商品能 24h 内发货？' },
  { icon: '📦', label: '查订单',   prompt: '帮我看下最近 7 天的订单状态，有没有需要确认收货的？' },
  { icon: '🧩', label: '组方案',   prompt: '我想为 [场景] 配齐一套商品，预算 [金额] WAZ — 帮我规划' },
]

// 状态文案 + 副标题（强化进度可视化）
const TASK_STATE_HINTS = {
  intent:    { title: '告诉 Agent 你想做什么',   subtitle: '用一句话描述需求，越具体效果越好' },
  planning:  { title: 'Agent 正在制定执行方案', subtitle: '正在调用思考能力规划步骤…' },
  review:    { title: '审核方案',                 subtitle: '看一眼 Agent 的计划，批准即可开干' },
  executing: { title: 'Agent 正在执行',           subtitle: '查询商品 / 锁价 / 比对 …' },
  results:   { title: 'Agent 已完成执行',         subtitle: '看结果是否满意，可让它重做或细化' },
  completed: { title: '任务完成 🎉',              subtitle: '可继续追问 或 开新任务' },
  cancelled: { title: '任务已取消',               subtitle: '点上方"新任务"开启下一次' },
}

// 流式光标动画样式（一次性注入）
function ensureAICursorStyle() {
  if (document.getElementById('ai-cursor-style')) return
  const el = document.createElement('style')
  el.id = 'ai-cursor-style'
  el.textContent = '@keyframes ai-cursor { 0%,50%{opacity:1} 51%,100%{opacity:0} }'
  document.head.appendChild(el)
}

// 实时 trace 动画样式：滑入 + 完成 flash
function ensureAITraceStyle() {
  if (document.getElementById('ai-trace-style')) return
  const el = document.createElement('style')
  el.id = 'ai-trace-style'
  el.textContent = `
    @keyframes ai-trace-slide-in {
      0%   { opacity: 0; transform: translateY(8px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    @keyframes ai-trace-flash {
      0%, 100% { background: transparent; }
      30%      { background: rgba(22,163,74,0.12); }
    }
    .ai-trace-card {
      opacity: 0;
      animation: ai-trace-slide-in 280ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
      border-radius: 8px;
    }
    .ai-trace-card-done {
      animation: ai-trace-flash 600ms ease;
    }
  `
  document.head.appendChild(el)
}

// 在消息容器末尾找/建一个 trace 容器（每次 send 重新建一个）
function ensureTraceContainer(msgEl) {
  if (!msgEl) return null
  let trace = msgEl.querySelector('#ai-trace-active')
  if (!trace) {
    trace = document.createElement('div')
    trace.id = 'ai-trace-active'
    trace.style.marginBottom = '10px'
    msgEl.appendChild(trace)
  }
  return trace
}

// AI Agent 演示画廊 — 新用户入口，4 个场景化 demo + 预期 agent 行为预览
// 一键运行 → seed prompt + 跳 #ai-recommend
async function renderAIDemo(app) {
  if (!state.user) return navigate('#login')
  const DEMOS = [
    {
      icon: '🎁', tag: '送礼',
      title: '帮我挑生日礼物',
      subtitle: '给妈妈 60 岁生日，预算 500 WAZ，实用 + 有心意',
      prompt: '我妈妈 60 岁生日，预算 500 WAZ 以内。希望礼物实用又有心意，最好是手工或有故事的。优先选 trusted 卖家。',
      expectedSteps: [
        { tool: 'webaz_search', desc: '搜索 500 WAZ 内的手工 / 健康类商品' },
        { tool: 'webaz_search', desc: '叠加 trusted 卖家筛选' },
        { tool: '推理',          desc: '从信誉 + 评价 + 故事性挑出 3 件' },
      ],
      tone: '#fef3c7',
    },
    {
      icon: '🔍', tag: '比价',
      title: '帮我比价外部链接',
      subtitle: '粘贴淘宝/京东链接，agent 自动查 WebAZ 上的同款',
      prompt: '我看上一件商品 https://item.example.com/p/123456 帮我看看 WebAZ 上有没有同款或更便宜的替代品，比较价格和卖家信誉。',
      expectedSteps: [
        { tool: 'webaz_agent_buy', desc: '解析外链 → 提取标题 + 价格' },
        { tool: 'webaz_search',    desc: '在 WebAZ 上找同款 / 相似品' },
        { tool: '推理',             desc: '比对价格 + 信誉，给出"买 WebAZ"或"原平台"建议' },
      ],
      tone: '#dbeafe',
    },
    {
      icon: '⭐', tag: '挑信誉',
      title: '只看高信誉卖家',
      subtitle: '推荐 3 件咖啡豆，trusted+ 卖家 + 退款率 < 5%',
      prompt: '推荐 3 件咖啡豆，只要 trusted 或以上卖家，退款率低于 5%，最好准时发货率 > 90%。',
      expectedSteps: [
        { tool: 'webaz_search',     desc: '类目筛 "咖啡豆"' },
        { tool: 'webaz_reputation', desc: '逐个查卖家 4 维信誉指标' },
        { tool: '推理',              desc: '保留达标的，挑出最优 3 件' },
      ],
      tone: '#dcfce7',
    },
    {
      icon: '🚛', tag: '看物流',
      title: '本地速达需求',
      subtitle: '上海能 24h 收到的耳机，预算 300 WAZ',
      prompt: '我在上海，找耳机预算 300 WAZ 以内，希望能 24h 内收到，备货时间短的优先。',
      expectedSteps: [
        { tool: 'webaz_search',  desc: '价格 ≤ 300 + 类目 "耳机"' },
        { tool: 'webaz_profile', desc: '读我的默认配送地址（上海）' },
        { tool: '过滤',           desc: '保留备货 ≤ 12h + ship_to 包含上海' },
      ],
      tone: '#fae8ff',
    },
  ]

  // 检测是否有可用 provider
  const chain = aiGetChain()
  const usable = chain.find(pid => { const p = aiGetProvider(pid); return p && p.enabled && (!p.keyRequired || aiGetKey(pid)) })
  const noProviderBanner = !usable ? `
    <div style="background:#fff7ed;border:0.5px solid #fed7aa;border-radius:12px;padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
      <div style="font-size:22px">🔐</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:#9a3412">${t('还没配置 AI provider')}</div>
        <div style="font-size:11px;color:#9a3412;margin-top:2px">${t('推荐先用 智谱 GLM-4-Flash（完全免费）')}</div>
      </div>
      <button class="btn btn-primary btn-sm" style="width:auto;padding:6px 14px;font-size:12px" onclick="navigate('#ai-recommend/config')">${t('去配置')}</button>
    </div>` : ''

  const cards = DEMOS.map((d, i) => `
    <div style="background:#fff;border:0.5px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <div style="font-size:26px;line-height:1">${d.icon}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
            <span style="font-size:10px;background:${d.tone};color:#1f2937;padding:1px 7px;border-radius:99px;font-weight:600">${t(d.tag)}</span>
          </div>
          <div style="font-size:15px;font-weight:600;color:#1f2937">${t(d.title)}</div>
        </div>
      </div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px;line-height:1.5">${t(d.subtitle)}</div>
      <details style="background:#f9fafb;border-radius:8px;margin-bottom:10px">
        <summary style="cursor:pointer;padding:8px 12px;font-size:11px;color:#374151;list-style:none">
          ▸ ${t('Agent 大致会这样做')}（${d.expectedSteps.length} ${t('步')}）
        </summary>
        <div style="padding:0 12px 10px">
          ${d.expectedSteps.map((s, j) => `
            <div style="display:flex;gap:8px;padding:4px 0;font-size:11px;color:#374151">
              <span style="color:#9ca3af;flex-shrink:0">${j+1}.</span>
              <code style="background:#eef2ff;color:#3730a3;padding:1px 6px;border-radius:4px;font-size:10px;font-family:ui-monospace,Consolas,monospace;flex-shrink:0">${escHtml(s.tool)}</code>
              <span style="color:#6b7280">${t(s.desc)}</span>
            </div>`).join('')}
        </div>
      </details>
      <div style="display:flex;gap:8px">
        <button data-prompt="${escAttr(d.prompt)}" onclick="runAIDemo(this.dataset.prompt)" style="flex:1;padding:11px;background:#007aff;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer">${t('一键运行')} →</button>
      </div>
      <div style="margin-top:8px;font-size:10px;color:#9ca3af;padding:6px 8px;background:#f9fafb;border-radius:6px;line-height:1.5">
        💬 ${t('提示原文')}：${escHtml(d.prompt.slice(0, 80))}${d.prompt.length > 80 ? '…' : ''}
      </div>
    </div>
  `).join('')

  // 对外 MCP 接入卡片 — Claude Desktop / Code 用户也能跑同样的 demo
  const mcpConfigJson = `{
  "mcpServers": {
    "webaz": {
      "command": "webaz",
      "env": {
        "WEBAZ_API_URL": "https://webaz.xyz"
      }
    }
  }
}`
  const mcpBlock = `
    <div style="margin-top:24px;background:#fff;border:0.5px solid #e5e7eb;border-radius:12px;padding:16px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <div style="font-size:22px">🔌</div>
        <div style="font-size:15px;font-weight:600;color:#1f2937">${t('用 Claude Desktop / Code 跑同样的 demo')}</div>
      </div>
      <div style="font-size:12px;color:#8e8e93;line-height:1.5;margin-bottom:12px">
        ${t('WebAZ 把所有工具同时暴露成 MCP 协议。外部 LLM client（Claude Desktop / Claude Code / 任何兼容 MCP 的 host）可以直接调用 — 上面 4 个 demo 提示词原样粘进 Claude 即可。')}
      </div>
      <div style="font-size:11px;font-weight:600;color:#374151;margin:10px 0 4px">${t('1. 安装 CLI')}</div>
      ${copyableCodeBlock('npm install -g @seasonkoh/webaz')}
      <div style="font-size:11px;font-weight:600;color:#374151;margin:10px 0 4px">${t('2. 在 claude_desktop_config.json 加入')}</div>
      ${copyableCodeBlock(mcpConfigJson)}
      <div style="font-size:11px;color:#8e8e93;margin-top:8px;line-height:1.5">${t('Claude Desktop config 路径：')}<br>· macOS: <code style="font-size:10px;background:#f3f4f6;padding:1px 5px;border-radius:4px">~/Library/Application Support/Claude/claude_desktop_config.json</code><br>· Windows: <code style="font-size:10px;background:#f3f4f6;padding:1px 5px;border-radius:4px">%APPDATA%\\Claude\\claude_desktop_config.json</code></div>
      <div style="font-size:11px;font-weight:600;color:#374151;margin:14px 0 4px">${t('3. 重启 Claude，把上面任一 demo 提示粘进去')}</div>
      <div style="font-size:11px;color:#8e8e93;line-height:1.5">${t('Claude 会自动调用 webaz_search / webaz_verify_price / webaz_place_order 等 30+ 个 tool。需要 api_key 时先用 webaz_register 注册或登录现有账号。')}</div>
      <div style="margin-top:14px;padding:10px 12px;background:#f0fdf4;border:0.5px solid #bbf7d0;border-radius:8px;font-size:11px;color:#15803d;line-height:1.5">
        💡 ${t('内部 vs 外部')}：${t('内部走浏览器接 LLM key 适合体验；外部 MCP 适合长跑 / 复杂任务 / 命令行自动化。两条路径后端、信誉、escrow 完全共享。')}
      </div>
    </div>`

  app.innerHTML = shell(`
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <button class="btn btn-gray btn-sm" style="width:auto" onclick="history.back()">${t('← 返回')}</button>
      <h1 class="page-title" style="margin:0">🤖 ${t('Agent 演示')}</h1>
    </div>
    <div style="font-size:12px;color:#8e8e93;margin-bottom:14px;line-height:1.5">
      ${t('WebAZ 的 agent 不只会聊天，它会调用真实工具完成任务。选一个场景体验：')}
    </div>
    ${noProviderBanner}
    ${cards}
    ${mcpBlock}
    <div style="text-align:center;font-size:11px;color:#9ca3af;margin-top:14px;line-height:1.6">
      ${t('用完后可在')} <a href="#ai-recommend" style="color:#007aff">${t('AI 推荐')}</a> ${t('继续追问或开新任务')}
    </div>
  `, 'ai-recommend')
}

// 可复制代码块（一键复制按钮）
function copyableCodeBlock(code) {
  const id = 'codeblk-' + Math.random().toString(36).slice(2, 9)
  return `<div style="position:relative;background:#1f2937;border-radius:8px;padding:10px 12px;margin-bottom:4px">
    <button onclick="copyCodeBlock('${id}', this)" style="position:absolute;top:6px;right:6px;background:rgba(255,255,255,0.1);border:0.5px solid rgba(255,255,255,0.2);color:#e5e7eb;font-size:10px;padding:3px 8px;border-radius:6px;cursor:pointer">${t('复制')}</button>
    <pre id="${id}" style="margin:0;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#e5e7eb;white-space:pre-wrap;word-break:break-all;padding-right:50px;line-height:1.6">${escHtml(code)}</pre>
  </div>`
}
window.copyCodeBlock = (id, btn) => {
  const el = document.getElementById(id)
  if (!el) return
  try {
    navigator.clipboard.writeText(el.textContent || '')
    if (btn) {
      const orig = btn.textContent
      btn.textContent = t('已复制')
      btn.style.background = 'rgba(34,197,94,0.3)'
      setTimeout(() => { btn.textContent = orig; btn.style.background = 'rgba(255,255,255,0.1)' }, 1500)
    }
  } catch { alert(el.textContent) }
}

window.runAIDemo = (prompt) => {
  // seed 到全局 state，让 renderAIRecommend 在 intent 阶段自动 prefill
  state._aiDemoSeed = String(prompt || '')
  navigate('#ai-recommend')
}

async function renderAIRecommend(app) {
  if (!state.user) return navigate('#login')
  await ensureProfileMini()
  ensureAICursorStyle()

  // 检查是否有任何可用 provider；没有 → 引导去配置
  const chain = aiGetChain()
  const usable = chain.find(pid => {
    const p = aiGetProvider(pid)
    return p && p.enabled && (!p.keyRequired || aiGetKey(pid))
  })
  if (!usable) {
    app.innerHTML = shell(`
      <h1 class="page-title">🤖 ${t('AI 推荐')}</h1>
      <div class="card" style="background:linear-gradient(135deg,#f5f3ff,#fdf4ff);border-color:#ddd6fe;text-align:center;padding:30px 16px">
        <div style="font-size:48px">🔐</div>
        <div style="font-size:16px;font-weight:600;margin:14px 0 6px">${t('还没有可用的 AI provider')}</div>
        <p style="font-size:12px;color:#374151;line-height:1.6;margin-bottom:16px">${t('需要先配置一个 LLM API。推荐先用 智谱 GLM-4-Flash（完全免费）')}</p>
        <button class="btn btn-primary" style="width:auto;padding:10px 24px" onclick="navigate('#ai-recommend/config')">${t('去配置 →')}</button>
      </div>
      <div style="text-align:center;font-size:11px;color:#9ca3af;margin-top:14px">${t('WebAZ Native 模型即将上线，届时无需配置 key 即可使用')}</div>
    `, 'ai-recommend')
    return
  }

  const conversations = await aiListConversations().catch(() => [])
  if (!state.aiCurrentConv) state.aiCurrentConv = conversations[0] || aiCreateConversation()
  const conv = state.aiCurrentConv
  const task = aiInitTask(conv)
  state.aiAttachments = state.aiAttachments || []   // [{name, type, dataURL, size}]
  const hint = TASK_STATE_HINTS[task.state] || TASK_STATE_HINTS.intent

  // 浏览器能力探测
  const speechSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition)

  app.innerHTML = shell(`
    ${renderAIStatusBar()}

    <!-- 任务进度卡：状态文案 + stepper -->
    <div style="background:linear-gradient(135deg,#f5f3ff,#fff);border:1px solid #ddd6fe;border-radius:12px;padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-size:14px;font-weight:700;color:#3730a3">${t(hint.title)}</div>
        <span style="font-size:10px;color:#6366f1;background:#eef2ff;padding:2px 8px;border-radius:99px;font-weight:600">${t(TASK_STATES[task.state]?.label || task.state)}</span>
      </div>
      <div style="font-size:11px;color:#6b7280;margin-bottom:8px;line-height:1.5">${t(hint.subtitle)}</div>
      ${renderTaskStepper(task)}
    </div>

    <div style="display:flex;flex-direction:column;height:calc(100vh - 360px);min-height:380px">
      <!-- 任务/对话切换条 -->
      <div style="display:flex;gap:6px;margin-bottom:8px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none">
        <button onclick="aiNewConv()" style="background:#4f46e5;color:#fff;border:none;border-radius:99px;padding:5px 12px;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0">+ ${t('新任务')}</button>
        ${conversations.slice(0, 8).map(c => {
          const st = (c.task?.state || 'intent')
          const stColor = TASK_STATES[st]?.color || '#6b7280'
          const isCur = c.id === conv.id
          return `<button style="background:${isCur ? '#eef2ff' : '#fff'};color:${isCur ? '#4f46e5' : '#374151'};border:1px solid ${isCur ? '#4f46e5' : '#e5e7eb'};border-radius:99px;padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0;display:inline-flex;align-items:center;gap:4px" onclick="aiLoadConv('${c.id}')"><span style="color:${stColor}">●</span>${escHtml((c.title || t('新任务')).slice(0, 14))}</button>`
        }).join('')}
      </div>

      <!-- 消息流 -->
      <div id="ai-messages" style="flex:1;overflow-y:auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;font-size:13px;line-height:1.6">
        ${renderAIMessages(conv.messages || [])}
      </div>

      ${renderTaskActions(task)}

      ${task.state === 'intent' && (!conv.messages || conv.messages.length === 0) ? `
      <!-- 快速模板（intent 空对话才显示）-->
      <div style="margin-top:8px;display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none">
        ${AI_QUICK_TEMPLATES.map(t2 => `
          <button onclick="aiFillTemplate('${t2.prompt.replace(/'/g, "\\'")}')"
            style="background:#fff;border:1px dashed #c7d2fe;border-radius:8px;padding:6px 10px;font-size:11px;color:#4338ca;cursor:pointer;white-space:nowrap;flex-shrink:0;font-weight:500">
            ${t2.icon} ${t(t2.label)}
          </button>`).join('')}
      </div>` : ''}

      <!-- 附件预览区（仅有附件时显示）-->
      <div id="ai-attach-preview" style="margin-top:8px"></div>

      <!-- 输入卡（textarea + 工具栏）-->
      <div style="margin-top:8px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:8px;box-shadow:0 1px 2px rgba(0,0,0,0.03)">
        <textarea id="ai-input" placeholder="${aiInputPlaceholder(task)}"
          style="width:100%;min-height:54px;border:none;outline:none;resize:none;font-size:13px;font-family:inherit;background:transparent;padding:6px 4px"
          oninput="aiAutoResizeInput(this)"
          onkeydown="if(event.key==='Enter'&&(event.metaKey||event.ctrlKey))aiSendMessage()"></textarea>

        <div style="display:flex;align-items:center;gap:4px;margin-top:4px;padding-top:6px;border-top:1px solid #f3f4f6">
          <!-- 图片附件 -->
          <input type="file" id="ai-file-img" accept="image/*" style="display:none" onchange="aiAttachFile(event,'image')">
          <button title="${t('附加图片')}" onclick="document.getElementById('ai-file-img').click()"
            style="background:none;border:none;cursor:pointer;padding:6px 8px;color:#6b7280;border-radius:6px;display:inline-flex;align-items:center"
            onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='none'">${SVG_CAMERA}</button>

          <!-- 视频/文件附件 -->
          <input type="file" id="ai-file-video" accept="video/*,application/pdf" style="display:none" onchange="aiAttachFile(event,'video')">
          <button title="${t('附加视频 / 文件')}" onclick="document.getElementById('ai-file-video').click()"
            style="background:none;border:none;cursor:pointer;padding:6px 8px;font-size:18px;color:#6b7280;border-radius:6px"
            onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='none'">📎</button>

          <!-- 语音输入 -->
          ${speechSupported ? `
          <button id="ai-voice-btn" title="${t('按住说话')}" onclick="aiToggleVoice()"
            style="background:none;border:none;cursor:pointer;padding:6px 8px;font-size:18px;color:#6b7280;border-radius:6px"
            onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='none'">🎤</button>
          ` : `
          <button title="${t('当前浏览器不支持语音')}" disabled
            style="background:none;border:none;padding:6px 8px;font-size:18px;color:#d1d5db;border-radius:6px;cursor:not-allowed">🎤</button>
          `}

          <div style="flex:1"></div>
          <span style="font-size:10px;color:#9ca3af;margin-right:4px">${t('Cmd/Ctrl + ↵')}</span>
          <button class="btn btn-primary" id="ai-send-btn" onclick="aiSendMessage()"
            style="width:auto;padding:7px 18px;font-size:13px;font-weight:600;border-radius:8px">${t('发送')} →</button>
        </div>
      </div>
    </div>
  `, 'ai-recommend')

  // 渲染已有附件
  aiRenderAttachPreview()
  setTimeout(() => {
    const m = document.getElementById('ai-messages')
    if (m) m.scrollTop = m.scrollHeight
    // Demo gallery → 跳进来时 prefill 提示词
    if (state._aiDemoSeed && task.state === 'intent') {
      const inp = document.getElementById('ai-input')
      if (inp) { inp.value = state._aiDemoSeed; aiAutoResizeInput(inp); inp.focus() }
      state._aiDemoSeed = null
    }
  }, 100)
}

// 附件管理
window.aiAttachFile = (e, kind) => {
  const file = e.target.files?.[0]
  e.target.value = ''   // reset for re-select
  if (!file) return
  const MAX = 8 * 1024 * 1024   // 8MB cap
  if (file.size > MAX) { alert(t('文件过大（≤ 8MB）')); return }
  if (state.aiAttachments.length >= 4) { alert(t('每次最多附 4 个文件')); return }
  const reader = new FileReader()
  reader.onload = () => {
    state.aiAttachments.push({ name: file.name, type: file.type, kind, dataURL: reader.result, size: file.size })
    aiRenderAttachPreview()
  }
  reader.readAsDataURL(file)
}

window.aiRemoveAttach = (idx) => {
  state.aiAttachments.splice(idx, 1)
  aiRenderAttachPreview()
}

function aiRenderAttachPreview() {
  const el = document.getElementById('ai-attach-preview')
  if (!el) return
  if (!state.aiAttachments?.length) { el.innerHTML = ''; return }
  el.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;padding:6px;background:#f9fafb;border:1px dashed #e5e7eb;border-radius:8px">
    ${state.aiAttachments.map((a, i) => {
      const preview = a.kind === 'image'
        ? `<img src="${a.dataURL}" style="width:42px;height:42px;object-fit:cover;border-radius:4px">`
        : `<div style="width:42px;height:42px;background:#e0e7ff;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:18px">📎</div>`
      return `<div style="display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:4px 6px 4px 4px">
        ${preview}
        <div style="font-size:10px;color:#374151;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.name)}</div>
        <button onclick="aiRemoveAttach(${i})" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:14px;padding:0 2px">×</button>
      </div>`
    }).join('')}
  </div>`
}

// 语音输入（Web Speech API；浏览器原生，无需后端）
let _aiSpeech = null
window.aiToggleVoice = () => {
  const btn = document.getElementById('ai-voice-btn')
  const inp = document.getElementById('ai-input')
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) { alert(t('当前浏览器不支持语音输入')); return }
  if (_aiSpeech) {
    _aiSpeech.stop()
    return
  }
  _aiSpeech = new SR()
  _aiSpeech.lang = window._lang === 'en' ? 'en-US' : 'zh-CN'
  _aiSpeech.interimResults = true
  _aiSpeech.continuous = true
  _aiSpeech.onstart = () => {
    if (btn) { btn.style.background = '#fee2e2'; btn.style.color = '#dc2626'; btn.title = t('点击停止') }
  }
  _aiSpeech.onresult = (e) => {
    let finalText = ''
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) finalText += r[0].transcript
      else interim += r[0].transcript
    }
    if (inp) {
      // 把已有 final 累加进 input，interim 暂存在 dataset 提示用
      if (finalText) inp.value = (inp.value || '') + finalText
      inp.dataset.interim = interim
      aiAutoResizeInput(inp)
    }
  }
  _aiSpeech.onerror = (e) => {
    console.warn('speech err', e.error)
  }
  _aiSpeech.onend = () => {
    _aiSpeech = null
    if (btn) { btn.style.background = ''; btn.style.color = '#6b7280'; btn.title = t('按住说话') }
    if (inp) delete inp.dataset.interim
  }
  _aiSpeech.start()
}

// 自动撑高 textarea
window.aiAutoResizeInput = (el) => {
  el.style.height = 'auto'
  el.style.height = Math.min(180, el.scrollHeight) + 'px'
}

// 快捷模板填入
window.aiFillTemplate = (prompt) => {
  const inp = document.getElementById('ai-input')
  if (!inp) return
  inp.value = prompt
  inp.focus()
  aiAutoResizeInput(inp)
  // 把光标定到第一个 [...] 占位符
  const m = prompt.match(/\[[^\]]+\]/)
  if (m) {
    const start = prompt.indexOf(m[0])
    inp.setSelectionRange(start, start + m[0].length)
  }
}

// 独立配置页（路由 #ai-recommend/config）
async function renderAIConfig(app) {
  if (!state.user) return navigate('#login')
  const chain = aiGetChain()
  const webazProvider = aiGetProvider('webaz')
  const freeProviders = AI_PROVIDERS.filter(p => p.id !== 'webaz' && p.free)
  const paidProviders = AI_PROVIDERS.filter(p => p.id !== 'webaz' && !p.free)

  const renderChainCard = () => {
    if (chain.length === 0) {
      return `<div class="card" style="background:#fef3c7;border-color:#fde68a;padding:12px;margin-bottom:14px">
        <div style="font-size:12px;color:#92400e">${t('还没配置任何 provider — 从下方选一个开始 👇')}</div>
      </div>`
    }
    return `<div class="card" style="margin-bottom:14px;padding:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-size:12px;font-weight:600;color:#374151">📊 ${t('当前调用链')}</div>
        <span style="font-size:10px;color:#9ca3af">${t('主用失败自动切换到下一个')}</span>
      </div>
      ${chain.map((pid, i) => {
        const p = aiGetProvider(pid)
        if (!p) return ''
        const ok = !p.keyRequired || aiGetKey(pid)
        const labelTag = i === 0 ? `<span style="background:#4f46e5;color:#fff;font-size:9px;padding:1px 6px;border-radius:99px;font-weight:600">${t('主用')}</span>` : `<span style="background:#e5e7eb;color:#6b7280;font-size:9px;padding:1px 6px;border-radius:99px">${t('备选')} ${i}</span>`
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:${i < chain.length - 1 ? '1px solid #f3f4f6' : 'none'}">
          <span style="font-size:11px;color:#9ca3af;width:14px">${i + 1}</span>
          ${labelTag}
          <span style="flex:1;font-size:12px;color:#111827;font-weight:500">${escHtml(p.name)}</span>
          ${p.enabled ? (ok ? '<span style="color:#059669;font-size:10px">✓</span>' : '<span style="color:#dc2626;font-size:10px">✗</span>') : '<span style="color:#fbbf24;font-size:10px">⏳</span>'}
          <button onclick="aiMoveInChain('${pid}','up');renderAIConfig(document.getElementById('app'))" ${i === 0 ? 'disabled' : ''} style="background:none;border:none;cursor:${i === 0 ? 'not-allowed' : 'pointer'};color:${i === 0 ? '#d1d5db' : '#6b7280'};padding:0 4px;font-size:14px">▲</button>
          <button onclick="aiMoveInChain('${pid}','down');renderAIConfig(document.getElementById('app'))" ${i === chain.length - 1 ? 'disabled' : ''} style="background:none;border:none;cursor:${i === chain.length - 1 ? 'not-allowed' : 'pointer'};color:${i === chain.length - 1 ? '#d1d5db' : '#6b7280'};padding:0 4px;font-size:14px">▼</button>
          <button onclick="aiRemoveFromChain('${pid}');renderAIConfig(document.getElementById('app'))" style="background:none;border:none;cursor:pointer;color:#dc2626;font-size:11px;padding:0 4px">×</button>
        </div>`
      }).join('')}
    </div>`
  }

  app.innerHTML = shell(`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <button class="btn btn-outline btn-sm" style="width:auto;padding:4px 12px;font-size:11px" onclick="navigate('#ai-recommend')">← ${t('返回对话')}</button>
      <h1 style="font-size:18px;margin:0">⚙️ ${t('AI 配置')}</h1>
    </div>

    <div class="card" style="background:linear-gradient(135deg,#f5f3ff,#fdf4ff);border-color:#ddd6fe;margin-bottom:14px;padding:14px">
      <div style="font-size:13px;font-weight:600;margin-bottom:4px">🔐 ${t('选择 AI Provider')}</div>
      <div style="font-size:11px;color:#6b7280;line-height:1.5">${t('Key 存在你浏览器本地，永不发给 WebAZ 服务器。Agent 直接调 LLM + WebAZ 工具集，所有上下文你独享。')}</div>
    </div>

    ${renderChainCard()}

    <!-- WebAZ Native: 独立第一行 -->
    <div style="margin-bottom:14px">${renderAIProviderCard(webazProvider, { active: false, fullWidth: true })}</div>

    <!-- 🆓 免费分组 -->
    <details style="margin-bottom:10px;background:#fff;border:1px solid #e5e7eb;border-radius:10px" ${chain.filter(p => p !== 'webaz').length === 0 ? 'open' : ''}>
      <summary style="padding:12px;font-size:13px;font-weight:600;cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;color:#374151">
        <span>🆓 ${t('免费 / 免费层')} <span style="font-weight:400;color:#9ca3af;font-size:11px">(${freeProviders.length} ${t('个')})</span></span>
        <span style="font-size:11px;color:#9ca3af">▾</span>
      </summary>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 12px 12px">
        ${freeProviders.map(p => renderAIProviderCard(p, { active: chain.includes(p.id) })).join('')}
      </div>
    </details>

    <!-- 💰 付费分组 -->
    <details style="margin-bottom:14px;background:#fff;border:1px solid #e5e7eb;border-radius:10px">
      <summary style="padding:12px;font-size:13px;font-weight:600;cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;color:#374151">
        <span>💰 ${t('付费')} <span style="font-weight:400;color:#9ca3af;font-size:11px">(${paidProviders.length} ${t('个')})</span></span>
        <span style="font-size:11px;color:#9ca3af">▾</span>
      </summary>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 12px 12px">
        ${paidProviders.map(p => renderAIProviderCard(p, { active: chain.includes(p.id) })).join('')}
      </div>
    </details>

    <div style="font-size:11px;color:#9ca3af;text-align:center">
      ${t('💡 推荐组合：智谱 GLM-4-Flash (主用，完全免费) + Groq (备选，海外极速) + DeepSeek (备选，长稳)')}
    </div>
  `, 'ai-recommend')
}

// 任务列表页（路由 #ai-recommend/tasks）
async function renderAITaskList(app) {
  if (!state.user) return navigate('#login')
  const all = await aiListConversations().catch(() => [])
  const groups = { active: [], completed: [], cancelled: [] }
  for (const c of all) {
    const st = c.task?.state || 'intent'
    if (st === 'completed') groups.completed.push(c)
    else if (st === 'cancelled') groups.cancelled.push(c)
    else groups.active.push(c)
  }
  const renderRow = (c) => {
    const st = c.task?.state || 'intent'
    const stInfo = TASK_STATES[st]
    return `<div onclick="aiLoadConv('${c.id}');navigate('#ai-recommend')" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px;cursor:pointer">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${stInfo.color};flex-shrink:0"></span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(c.title || t('未命名任务'))}</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:2px">${t(stInfo.label)} · ${fmtTime(c.updated_at || c.created_at)}${c.task?.rating ? ' · ' + '⭐'.repeat(c.task.rating) : ''}</div>
      </div>
      <button onclick="event.stopPropagation();aiDeleteTask('${c.id}')" style="background:none;border:none;color:#dc2626;font-size:14px;cursor:pointer;padding:4px 8px" title="${t('删除')}">×</button>
    </div>`
  }
  app.innerHTML = shell(`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <button class="btn btn-outline btn-sm" style="width:auto;padding:4px 12px;font-size:11px" onclick="navigate('#ai-recommend')">← ${t('返回对话')}</button>
      <h1 style="font-size:18px;margin:0">📋 ${t('任务管理')}</h1>
    </div>
    ${all.length === 0 ? `
      <div class="card" style="text-align:center;padding:30px 16px">
        <div style="font-size:48px;margin-bottom:10px">📭</div>
        <div style="font-size:13px;color:#9ca3af">${t('还没有任务')}</div>
        <button class="btn btn-primary" style="width:auto;padding:8px 24px;margin-top:14px" onclick="aiNewConv();navigate('#ai-recommend')">${t('开始第一个任务')}</button>
      </div>
    ` : `
      ${groups.active.length > 0 ? `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">🔄 ${t('进行中')} (${groups.active.length})</div>
          ${groups.active.map(renderRow).join('')}
        </div>
      ` : ''}
      ${groups.completed.length > 0 ? `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">✅ ${t('已完成')} (${groups.completed.length})</div>
          ${groups.completed.map(renderRow).join('')}
        </div>
      ` : ''}
      ${groups.cancelled.length > 0 ? `
        <details style="margin-bottom:14px">
          <summary style="font-size:11px;color:#9ca3af;cursor:pointer;margin-bottom:6px">⊘ ${t('已取消')} (${groups.cancelled.length})</summary>
          ${groups.cancelled.map(renderRow).join('')}
        </details>
      ` : ''}
    `}
  `, 'ai-recommend')
}

window.aiDeleteTask = async (id) => {
  if (!confirm(t('删除该任务？此操作不可恢复'))) return
  await aiDeleteConversation(id)
  if (state.aiCurrentConv?.id === id) state.aiCurrentConv = null
  toast$(t('已删除'))
  renderAITaskList(document.getElementById('app'))
}

// 任务工作流操作
window.aiApprovePlan = async () => {
  const conv = state.aiCurrentConv
  if (!conv?.task) return
  conv.task.state = 'executing'
  conv.task.decision_history = conv.task.decision_history || []
  conv.task.decision_history.push({ at: new Date().toISOString(), action: 'approve' })
  await aiSaveConversation(conv)
  // 自动给 AI 发执行指令
  renderAIRecommend(document.getElementById('app'))
  setTimeout(() => _aiSendRaw('（用户批准方案，请按上述方案执行）'), 100)
}

window.aiRequestModify = () => {
  const conv = state.aiCurrentConv
  if (!conv?.task) return
  // 保留 review 状态，让用户在 input 输入修改意见后点发送，state 会回 planning（下一轮 chatTurn 处理）
  conv.task.state = 'planning'  // 重新进入规划
  conv.task.decision_history = conv.task.decision_history || []
  conv.task.decision_history.push({ at: new Date().toISOString(), action: 'modify' })
  toast$(t('请在输入栏说明你想怎么改'), 'info')
  renderAIRecommend(document.getElementById('app'))
  setTimeout(() => document.getElementById('ai-input')?.focus(), 100)
}

window.aiCancelTask = async () => {
  const conv = state.aiCurrentConv
  if (!conv?.task) return
  if (!confirm(t('确认取消任务？'))) return
  conv.task.state = 'cancelled'
  conv.task.decision_history = conv.task.decision_history || []
  conv.task.decision_history.push({ at: new Date().toISOString(), action: 'cancel' })
  await aiSaveConversation(conv)
  toast$(t('任务已取消'))
  renderAIRecommend(document.getElementById('app'))
}

window.aiRequestRedo = async () => {
  const conv = state.aiCurrentConv
  if (!conv?.task) return
  conv.task.state = 'executing'
  conv.task.results = null
  conv.task.decision_history = conv.task.decision_history || []
  conv.task.decision_history.push({ at: new Date().toISOString(), action: 'redo' })
  await aiSaveConversation(conv)
  renderAIRecommend(document.getElementById('app'))
  setTimeout(() => _aiSendRaw('（用户要求重做，请再次执行）'), 100)
}

window.aiOpenRateModal = () => {
  _openModal(`
    <h2 style="font-size:16px;font-weight:600;margin-bottom:10px">⭐ ${t('完成并评价')}</h2>
    <div style="font-size:12px;color:#6b7280;margin-bottom:12px">${t('给本次任务的满意度评分（1-5 星）')}</div>
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:14px" id="rate-stars">
      ${[1,2,3,4,5].map(n => `<button data-n="${n}" onclick="aiSetRateStars(${n})" style="background:none;border:none;font-size:32px;cursor:pointer;color:#d1d5db;padding:0;transition:transform 0.1s">☆</button>`).join('')}
    </div>
    <div class="form-group">
      <label class="form-label" style="font-size:12px">${t('反馈（可选）')}</label>
      <textarea id="rate-feedback" class="form-control" placeholder="${t('哪里好 / 哪里可以改进…')}" style="font-size:13px;min-height:50px;resize:vertical;font-family:inherit"></textarea>
    </div>
    <div id="rate-msg" style="margin-bottom:8px"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-outline" style="flex:1" onclick="closeModal()">${t('取消')}</button>
      <button class="btn btn-primary" style="flex:1" onclick="aiSubmitRate()">${t('提交评价')}</button>
    </div>
  `)
}
window._aiRating = 0
window.aiSetRateStars = (n) => {
  window._aiRating = n
  document.querySelectorAll('#rate-stars button').forEach(btn => {
    const k = Number(btn.dataset.n)
    btn.textContent = k <= n ? '★' : '☆'
    btn.style.color = k <= n ? '#f59e0b' : '#d1d5db'
  })
}
window.aiSubmitRate = async () => {
  const rating = window._aiRating
  if (!rating) { const m = document.getElementById('rate-msg'); if (m) m.innerHTML = alert$('error', t('请选择 1-5 星')); return }
  const feedback = document.getElementById('rate-feedback')?.value?.trim() || ''
  const conv = state.aiCurrentConv
  if (!conv?.task) return
  conv.task.state = 'completed'
  conv.task.rating = rating
  conv.task.feedback = feedback
  await aiSaveConversation(conv)
  window._aiRating = 0
  closeModal()
  toast$(t('已记录评价') + ' ' + '⭐'.repeat(rating))
  renderAIRecommend(document.getElementById('app'))
}

// 内部：用既有 aiSendMessage 流程但直接传入文本（用于工作流自动消息）
async function _aiSendRaw(text) {
  const inp = document.getElementById('ai-input')
  if (inp) inp.value = text
  return aiSendMessage()
}

// 旧的 aiForceConfig 兼容（路由跳转）
window.aiForceConfigPage = () => navigate('#ai-recommend/config')
window.aiExitConfig = () => navigate('#ai-recommend')
window.aiSetModel = (mid) => {
  const { provider } = aiGetActive()
  aiSetActive(provider.id, mid)
  toast$(t('已切换模型'))
}

window.aiOpenProviderConfig = (pid) => {
  const p = aiGetProvider(pid)
  if (!p || !p.enabled) return toast$(t('该 provider 暂未上线'), 'error')
  const existingKey = aiGetKey(pid) || ''
  const existingEndpoint = aiGetEndpoint(pid) || ''
  const isCustom = !!p.isCustom
  const cName   = localStorage.getItem('webaz_ai_custom_name')   || ''
  const cModel  = localStorage.getItem('webaz_ai_custom_model')  || ''
  const cLabel  = localStorage.getItem('webaz_ai_custom_label')  || ''
  const cFormat = localStorage.getItem('webaz_ai_custom_format') || 'openai'

  _openModal(`
    <h2 style="font-size:16px;font-weight:600;margin-bottom:6px">${escHtml(p.name)}</h2>
    <div style="font-size:12px;color:#6b7280;margin-bottom:10px">${t(p.desc)}</div>

    ${isCustom ? `
      <div class="form-group">
        <label class="form-label">${t('显示名称')}</label>
        <input id="ai-pcfg-cname" class="form-control" placeholder="${t('例：我的 LangChain Agent')}" value="${escHtml(cName)}" style="font-size:13px">
      </div>
    ` : ''}

    ${p.keyRequired || (isCustom) ? `
      <div class="form-group">
        <label class="form-label">${t(isCustom ? 'Bearer Token (可选)' : 'API Key')}</label>
        <input id="ai-pcfg-key" type="password" class="form-control" placeholder="${p.keyPrefix || (isCustom ? '可空' : '')}..." value="${escHtml(existingKey)}" style="font-family:monospace;font-size:13px">
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">${t(p.keyHint)}</div>
      </div>
    ` : `
      <div style="font-size:12px;color:#6b7280;margin-bottom:8px">${t('此 provider 无需 API key')}</div>
    `}

    ${p.customEndpoint ? `
      <div class="form-group">
        <label class="form-label">${t('Endpoint URL')}</label>
        <input id="ai-pcfg-ep" type="text" class="form-control" placeholder="${escHtml(p.defaultEndpoint)}" value="${escHtml(existingEndpoint || p.defaultEndpoint)}" style="font-family:monospace;font-size:12px">
      </div>
    ` : ''}

    ${isCustom ? `
      <div class="form-group">
        <label class="form-label">${t('模型 ID')}</label>
        <input id="ai-pcfg-cmodel" class="form-control" placeholder="${t('例：gpt-4 / claude-3 / 你的 agent 接受的 model 字段')}" value="${escHtml(cModel)}" style="font-family:monospace;font-size:13px">
      </div>
      <div class="form-group">
        <label class="form-label">${t('模型显示标签 (可选)')}</label>
        <input id="ai-pcfg-clabel" class="form-control" placeholder="${t('例：我的购物 agent v1')}" value="${escHtml(cLabel)}" style="font-size:13px">
      </div>
      <div class="form-group">
        <label class="form-label">${t('协议格式')}</label>
        <select id="ai-pcfg-cformat" class="form-control" style="font-size:13px">
          <option value="openai" ${cFormat==='openai'?'selected':''}>OpenAI 兼容 (chat/completions)</option>
          <option value="anthropic" ${cFormat==='anthropic'?'selected':''}>Anthropic 兼容 (messages)</option>
        </select>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">${t('多数自建 agent / 代理用 OpenAI 协议')}</div>
      </div>
    ` : `
      <div class="form-group">
        <label class="form-label">${t('默认模型')}</label>
        <select id="ai-pcfg-model" class="form-control" style="font-size:13px">
          ${p.models.map(m => `<option value="${m.id}" ${m.id === (localStorage.getItem('webaz_ai_model_' + p.id) || p.defaultModel) ? 'selected' : ''}>${escHtml(m.label)}</option>`).join('')}
        </select>
      </div>
    `}

    <div id="ai-pcfg-msg" style="margin-bottom:8px"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-outline" style="flex:1;min-width:80px" onclick="closeModal()">${t('取消')}</button>
      ${existingKey || !p.keyRequired ? `<button class="btn btn-outline" style="width:auto;color:#dc2626;border-color:#fca5a5;padding:0 12px" onclick="aiClearProviderKey('${p.id}')">${t('清除')}</button>` : ''}
      <button class="btn btn-outline" style="flex:1;min-width:90px;border-color:#0891b2;color:#0891b2" onclick="aiSaveProviderConfig('${p.id}','fallback')">${t('加入备选')}</button>
      <button class="btn btn-primary" style="flex:1;min-width:90px" onclick="aiSaveProviderConfig('${p.id}','primary')">${t('设为主用')}</button>
    </div>
  `)
  setTimeout(() => document.getElementById(isCustom ? 'ai-pcfg-cname' : 'ai-pcfg-key')?.focus(), 50)
}

window.aiSaveProviderConfig = (pid, mode) => {
  const p = aiGetProvider(pid)
  const msg = document.getElementById('ai-pcfg-msg')
  const isCustom = !!p.isCustom

  if (isCustom) {
    // custom: name + model + format 都来自用户填的字段
    const cname  = document.getElementById('ai-pcfg-cname')?.value?.trim() || '我的 Agent'
    const cmodel = document.getElementById('ai-pcfg-cmodel')?.value?.trim()
    const clabel = document.getElementById('ai-pcfg-clabel')?.value?.trim()
    const cformat = document.getElementById('ai-pcfg-cformat')?.value || 'openai'
    if (!cmodel) { if (msg) msg.innerHTML = alert$('error', t('请填写模型 ID')); return }
    localStorage.setItem('webaz_ai_custom_name', cname)
    localStorage.setItem('webaz_ai_custom_model', cmodel)
    localStorage.setItem('webaz_ai_custom_label', clabel || cmodel)
    localStorage.setItem('webaz_ai_custom_format', cformat)
    // key 可选
    const key = document.getElementById('ai-pcfg-key')?.value?.trim() || ''
    if (key) aiSetKey(pid, key)
    else { localStorage.removeItem('webaz_ai_key_' + pid) }
    // endpoint
    const ep = document.getElementById('ai-pcfg-ep')?.value?.trim() || p.defaultEndpoint
    if (!/^https?:\/\//.test(ep)) { if (msg) msg.innerHTML = alert$('error', t('Endpoint 必须以 http:// 或 https:// 开头')); return }
    aiSetEndpoint(pid, ep)
  } else {
    if (p.keyRequired) {
      const key = document.getElementById('ai-pcfg-key')?.value?.trim() || ''
      if (!key) { if (msg) msg.innerHTML = alert$('error', t('请填写 API key')); return }
      if (p.keyPrefix && !key.startsWith(p.keyPrefix)) { if (msg) msg.innerHTML = alert$('error', t('API key 应以 ') + p.keyPrefix + t(' 开头')); return }
      aiSetKey(pid, key)
    }
    if (p.customEndpoint) {
      const ep = document.getElementById('ai-pcfg-ep')?.value?.trim() || p.defaultEndpoint
      aiSetEndpoint(pid, ep)
    }
    const mid = document.getElementById('ai-pcfg-model')?.value
    if (mid) localStorage.setItem('webaz_ai_model_' + pid, mid)
  }
  aiAddToChain(pid, mode === 'primary')
  closeModal()
  toast$(t(mode === 'primary' ? '已设为主用 ' : '已加入备选 ') + p.name)
  // 配置完成后回到主对话页
  navigate('#ai-recommend')
}

window.aiClearProviderKey = (pid) => {
  const p = aiGetProvider(pid)
  if (!confirm(t('清除 ') + p.name + t(' 的 API key？'))) return
  localStorage.removeItem('webaz_ai_key_' + pid)
  if (pid === 'anthropic') localStorage.removeItem('webaz_ai_key')
  aiRemoveFromChain(pid)
  closeModal()
  toast$(t('已清除'))
  // 留在 config 页（用户可能还要继续配其他 provider）
  if (location.hash === '#ai-recommend/config') renderAIConfig(document.getElementById('app'))
  else renderAIRecommend(document.getElementById('app'))
}

window.aiNewConv = async () => {
  const conv = aiCreateConversation()
  state.aiCurrentConv = conv
  await aiSaveConversation(conv)
  renderAIRecommend(document.getElementById('app'))
}

window.aiLoadConv = async (id) => {
  const conv = await aiGetConversation(id)
  if (conv) state.aiCurrentConv = conv
  renderAIRecommend(document.getElementById('app'))
}

window.aiSendMessage = async () => {
  const inp = document.getElementById('ai-input')
  const text = inp?.value?.trim()
  const attachments = state.aiAttachments || []
  if (!text && attachments.length === 0) return
  const btn = document.getElementById('ai-send-btn')
  const msgEl = document.getElementById('ai-messages')
  const conv = state.aiCurrentConv = state.aiCurrentConv || aiCreateConversation()

  // 视觉路由：当前模型支持视觉 + 有图 → attachments 直接走 image content；
  // 否则（非视觉模型 / 视频文件等）→ 文件名以 text marker 注入
  const visionSupported = aiCurrentModelSupportsVision()
  const visionAttachments = attachments.filter(a => a.kind === 'image')
  const nonVisionAttachments = attachments.filter(a => a.kind !== 'image' || !visionSupported)
  let finalText = text || ''
  if (nonVisionAttachments.length > 0) {
    const marks = nonVisionAttachments.map(a => `[${a.kind === 'image' ? '🖼' : '📎'} ${a.name}]`).join(' ')
    finalText = (finalText ? finalText + '\n\n' : '') + marks
  }
  // 真正喂给 chatTurn 的 attachments — 仅含视觉模型能用的图片
  const passAttachments = visionSupported ? visionAttachments : []

  // 乐观渲染用户消息（含视觉时构造 content array）
  if (passAttachments.length > 0) {
    const content = []
    if (finalText) content.push({ type: 'text', text: finalText })
    for (const a of passAttachments) {
      const p = aiParseDataURL(a.dataURL)
      if (p) content.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } })
    }
    conv.messages.push({ role: 'user', content })
  } else {
    conv.messages.push({ role: 'user', content: finalText })
  }
  if (msgEl) { msgEl.innerHTML = renderAIMessages(conv.messages); msgEl.scrollTop = msgEl.scrollHeight }
  inp.value = ''
  state.aiAttachments = []
  aiRenderAttachPreview()
  conv.messages.pop()   // chatTurn 会重新 add

  // 思考指示器（流式时会被替换成增长文本气泡）
  let streamingText = ''
  if (msgEl) {
    msgEl.insertAdjacentHTML('beforeend', `<div id="ai-thinking" style="display:flex;justify-content:flex-start;margin-bottom:10px"><div id="ai-thinking-inner" style="background:#f3f4f6;border-radius:10px 10px 10px 2px;padding:8px 12px;color:#374151;font-size:13px;max-width:90%;line-height:1.6"><span style="font-style:italic;color:#6b7280">🤖 ${t('思考中…')}</span></div></div>`)
    msgEl.scrollTop = msgEl.scrollHeight
  }

  if (btn) btn.disabled = true
  try {
    ensureAITraceStyle()
    await aiChatTurn(conv, finalText, passAttachments, (status, payload) => {
      const tIn = document.getElementById('ai-thinking-inner')
      if (status === 'text' && tIn) {
        streamingText += payload
        tIn.innerHTML = renderAIMarkdown(streamingText) + '<span style="display:inline-block;width:6px;height:14px;background:#9ca3af;margin-left:2px;animation:ai-cursor 1s infinite;vertical-align:middle"></span>'
        if (msgEl) msgEl.scrollTop = msgEl.scrollHeight
      } else if (status === 'tool_use_start') {
        // 实时 trace：开一个 trace 容器，把每个 tool 渲染成 ⏳ 卡（slide-in 错开 80ms）
        streamingText = ''
        if (tIn) tIn.innerHTML = `<span style="font-style:italic;color:#6b7280">🔧 ${t('调用工具')}…</span>`
        const trace = ensureTraceContainer(msgEl)
        for (let i = 0; i < payload.length; i++) {
          const tu = payload[i]
          const card = document.createElement('div')
          card.setAttribute('data-tool-id', tu.id)
          card.className = 'ai-trace-card'
          card.style.animationDelay = (i * 80) + 'ms'
          card.innerHTML = renderToolCard(tu, null)
          trace.appendChild(card)
        }
        if (msgEl) msgEl.scrollTop = msgEl.scrollHeight
      } else if (status === 'tool_result_one') {
        // 把对应卡片 swap 到 ✅，加 flash 高亮
        const card = document.querySelector(`.ai-trace-card[data-tool-id="${payload.id}"]`)
        if (card) {
          card.classList.add('ai-trace-card-done')
          card.innerHTML = renderToolCard({ id: payload.id, name: payload.name, input: payload.input }, payload.content)
          setTimeout(() => card.classList.remove('ai-trace-card-done'), 600)
        }
        if (msgEl) msgEl.scrollTop = msgEl.scrollHeight
      } else if (status === 'thinking' && !streamingText && tIn) {
        tIn.innerHTML = `<span style="font-style:italic;color:#6b7280">🤖 ${t('思考中… 第')} ${payload} ${t('轮')}</span>`
      }
    })
    if (!conv.title) {
      const first = conv.messages.find(m => m.role === 'user' && typeof m.content === 'string')
      if (first) { conv.title = first.content.slice(0, 30); await aiSaveConversation(conv) }
    }
  } catch (e) {
    conv.messages.push({ role: 'assistant', content: [{ type: 'text', text: `❌ ${e.message || e}` }] })
    await aiSaveConversation(conv)
  }

  if (msgEl) { msgEl.innerHTML = renderAIMessages(conv.messages); msgEl.scrollTop = msgEl.scrollHeight }
  if (btn) btn.disabled = false

  // TTS：把最新 assistant text 块朗读
  if (aiTTS.isEnabled()) {
    const last = [...conv.messages].reverse().find(m => m.role === 'assistant' && Array.isArray(m.content))
    if (last) {
      const text = last.content.filter(c => c.type === 'text').map(c => c.text).join(' ').trim()
      if (text) aiTTS.speak(text)
    }
  }
}

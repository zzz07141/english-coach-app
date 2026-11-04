// 英语教练 · AI 对话引擎
// 直接调各家大模型的 OpenAI 兼容接口，key 只存在这台设备的 localStorage 里。
// 选的都是对浏览器跨域放行（CORS 预检返回 access-control-allow-origin）的服务。
(function () {
  'use strict';

  var STORE = 'english-coach-ai-v1';

  var PROVIDERS = {
    deepseek: {
      name: 'DeepSeek',
      base: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      note: '最便宜，一次对话一分钱都不到',
    },
    siliconflow: {
      name: '硅基流动',
      base: 'https://api.siliconflow.cn/v1/chat/completions',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      keyUrl: 'https://cloud.siliconflow.cn/account/ak',
      note: '有免费额度，模型名可以自己改',
    },
    dashscope: {
      name: '通义千问',
      base: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-plus',
      keyUrl: 'https://bailian.console.aliyun.com/',
      note: '阿里云，新用户有免费 token',
    },
    moonshot: {
      name: 'Kimi',
      base: 'https://api.moonshot.cn/v1/chat/completions',
      model: 'moonshot-v1-8k',
      keyUrl: 'https://platform.moonshot.cn/console/api-keys',
      note: '中文好，价格中等',
    },
  };

  function getConfig() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return { provider: 'deepseek', key: '', model: '' };
      var c = JSON.parse(raw) || {};
      return {
        provider: PROVIDERS[c.provider] ? c.provider : 'deepseek',
        key: String(c.key || ''),
        model: String(c.model || ''),
      };
    } catch (e) {
      return { provider: 'deepseek', key: '', model: '' };
    }
  }

  function setConfig(c) {
    c = c || {};
    localStorage.setItem(STORE, JSON.stringify({
      provider: PROVIDERS[c.provider] ? c.provider : 'deepseek',
      key: String(c.key || '').trim(),
      model: String(c.model || '').trim(),
    }));
  }

  function hasKey() {
    return !!getConfig().key;
  }

  function providerInfo(id) {
    return PROVIDERS[id] || PROVIDERS.deepseek;
  }

  // 把各种失败翻译成一句人话
  function describe(err) {
    var m = String((err && err.message) || err || '');
    if (m === 'NO_KEY') return '还没填 API key';
    if (m === 'BAD_KEY') return 'key 不对，或者已经过期了';
    if (m === 'LIMIT') return '请求太密了，等一下再试';
    if (m === 'TIMEOUT') return '等太久没回，网络不太行';
    if (m === 'NETWORK') return '连不上这家服务，检查一下网络';
    if (m === 'EMPTY') return '模型回了空话';
    if (m.indexOf('HTTP_402') === 0) return '账户余额不够了';
    if (m.indexOf('HTTP_') === 0) return '服务出错了（' + m.slice(5, 60) + '）';
    return m || '不知道哪里出错了';
  }

  async function ask(messages, opts) {
    opts = opts || {};
    var c = getConfig();
    if (!c.key) throw new Error('NO_KEY');
    var p = providerInfo(c.provider);

    var body = {
      model: c.model || p.model,
      messages: messages,
      temperature: opts.temperature == null ? 0.7 : opts.temperature,
      max_tokens: opts.maxTokens || 400,
      stream: false,
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 35000);
    var res;
    try {
      res = await fetch(p.base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + c.key,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('TIMEOUT');
      throw new Error('NETWORK');
    }
    clearTimeout(timer);

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('BAD_KEY');
      if (res.status === 429) throw new Error('LIMIT');
      throw new Error('HTTP_' + res.status);
    }
    var data = await res.json();
    var text =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
    if (!text) throw new Error('EMPTY');
    return String(text).trim();
  }

  // 模型偶尔会包一层 ```json，这里兜一下
  function parseJson(text) {
    var s = String(text || '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    var i = s.indexOf('{');
    var j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  window.Chat = {
    PROVIDERS: PROVIDERS,
    getConfig: getConfig,
    setConfig: setConfig,
    hasKey: hasKey,
    providerInfo: providerInfo,
    describe: describe,
    ask: ask,
    parseJson: parseJson,
  };
})();

// 语音：本地 whisper（跟读打分）+ 手机自带识别（快速）双引擎
// 关键改动：
//  1) onnxruntime 的 wasm 从 jsDelivr 改成同源 vendor/ —— 国内 CDN 被墙时不再整个加载失败
//  2) 两条路互为兜底：一条不通自动换另一条，并把真实原因给到界面
//  3) 语音包可以提前并行分段下载（并发 4 段），下完塞进 Cache Storage，之后离线可用
(function () {
  'use strict';

  var MODEL_ID = 'whisper-tiny.en';
  var LIB_URL = './vendor/transformers.min.js';
  // wasm 放 ./vendor/：onnxruntime 用「字符串拼接」把前缀加上文件名，
  // 但两个文件各自的基准不一样——
  //   .wasm  → 相对【页面】（/），所以 './vendor/ort-wasm...wasm' 落在 /vendor/
  //   .mjs   → 相对【transformers.min.js 所在目录】（/vendor/），于是成了 /vendor/vendor/
  // 所以 .mjs 在 vendor/vendor/ 放了一份拷贝（44KB），两边都能命中。
  var WASM_DIR = './vendor/';
  var MODEL_BASE = './';
  var CACHE_NAME = 'english-coach-asr-v1';
  var PREF_KEY = 'english-coach-voice-v1';

  // 语音包清单（第一次要下这些，之后永久离线可用）
  // GitHub Pages 在国内经常只有 30-80KB/s，jsDelivr 的同一个文件能到 300-800KB/s，
  // 所以每个文件都尽量给一个镜像源，下载时先试镜像、失败再回落到同源。
  // jsDelivr 单文件上限 20MB —— 30MB 的 decoder 只能走 GitHub Pages（多路分段并行）。
  var GH_MIRROR = 'https://cdn.jsdelivr.net/gh/zzz07141/english-coach-app@main/';
  var NPM_MIRROR = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/';
  var PACK = [
    {
      url: './vendor/ort-wasm-simd-threaded.jsep.wasm',
      mb: 20.6,
      mirrors: [NPM_MIRROR + 'ort-wasm-simd-threaded.jsep.wasm'],
    },
    { url: './whisper-tiny.en/config.json', mb: 0.01, mirrors: [GH_MIRROR + 'whisper-tiny.en/config.json'] },
    {
      url: './whisper-tiny.en/generation_config.json',
      mb: 0.01,
      mirrors: [GH_MIRROR + 'whisper-tiny.en/generation_config.json'],
    },
    {
      url: './whisper-tiny.en/preprocessor_config.json',
      mb: 0.01,
      mirrors: [GH_MIRROR + 'whisper-tiny.en/preprocessor_config.json'],
    },
    { url: './whisper-tiny.en/tokenizer.json', mb: 2.03, mirrors: [GH_MIRROR + 'whisper-tiny.en/tokenizer.json'] },
    {
      url: './whisper-tiny.en/tokenizer_config.json',
      mb: 0.01,
      mirrors: [GH_MIRROR + 'whisper-tiny.en/tokenizer_config.json'],
    },
    {
      url: './whisper-tiny.en/onnx/encoder_model_quantized.onnx',
      mb: 9.66,
      mirrors: [GH_MIRROR + 'whisper-tiny.en/onnx/encoder_model_quantized.onnx'],
    },
    // 30MB 超 jsDelivr 单文件上限，所以在仓库里切成两段 ~15MB 的分片，
    // 从镜像分别拉下来再拼回去（拼完 md5 与原文件一致）
    {
      url: './whisper-tiny.en/onnx/decoder_model_merged_quantized.onnx',
      mb: 29.3,
      parts: [
        { url: './whisper-tiny.en/onnx/parts/decoder.p1.bin', mb: 14.65, mirrors: [GH_MIRROR + 'whisper-tiny.en/onnx/parts/decoder.p1.bin'] },
        { url: './whisper-tiny.en/onnx/parts/decoder.p2.bin', mb: 14.65, mirrors: [GH_MIRROR + 'whisper-tiny.en/onnx/parts/decoder.p2.bin'] },
      ],
      mirrors: [],
    },
  ];
  var PACK_MB = PACK.reduce(function (n, x) { return n + x.mb; }, 0);

  var pipe = null;
  var loadingPromise = null;
  var state = 'idle'; // idle | loading | ready | failed
  var lastError = '';
  var lastErrorCode = '';
  var cacheFlag = null; // null=未知 true=已缓存 false=没缓存
  var progressHook = null; // 界面挂一次就好，加载过程中一直能收到进度

  function setState(s, err, code) {
    state = s;
    if (err) {
      lastError = String(err && err.message ? err.message : err);
      lastErrorCode = code || '';
    }
  }

  function pref() {
    try {
      var v = localStorage.getItem(PREF_KEY);
      if (v === 'browser' || v === 'local') return v;
    } catch (e) {}
    return 'auto';
  }
  function setPref(v) {
    try {
      if (v === 'browser' || v === 'local' || v === 'auto') localStorage.setItem(PREF_KEY, v);
    } catch (e) {}
  }

  function hasMic() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function srCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  // ---------- 加载本地模型 ----------

  async function loadLib() {
    var mod = await import(LIB_URL);
    mod.env.allowRemoteModels = false;
    mod.env.allowLocalModels = true;
    mod.env.localModelPath = MODEL_BASE;
    // 关键：把 ort 的 wasm 指到同源目录
    var w = mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm;
    if (w) {
      w.wasmPaths = WASM_DIR;
      w.proxy = false;
      w.numThreads = 1; // 手机上没有 SharedArrayBuffer，单线程最稳
    }
    return mod;
  }

  async function load(onProgress) {
    if (pipe) { setState('ready'); return pipe; }
    if (loadingPromise) return loadingPromise;
    setState('loading');
    loadingPromise = (async function () {
      try {
        var mod = await loadLib();
        var asr = await mod.pipeline('automatic-speech-recognition', MODEL_ID, {
          dtype: 'q8',
          device: 'wasm',
          progress_callback: function (p) {
            try { if (onProgress) onProgress(p); } catch (e) {}
            try { if (progressHook) progressHook(p); } catch (e) {}
          },
        });
        pipe = asr;
        setState('ready');
        cacheFlag = true;
        return asr;
      } catch (e) {
        var code = 'L_FAIL';
        var msg = String((e && e.message) || e);
        if (/fetch|network|Failed to load|import|dynamically imported/i.test(msg)) code = 'L_NET';
        if (/wasm|ort|WebAssembly/i.test(msg)) code = 'L_WASM';
        if (/quota|storage|QuotaExceeded/i.test(msg)) code = 'L_QUOTA';
        setState('failed', e, code);
        loadingPromise = null;
        var err = new Error(describeCode(code, msg));
        err.code = code;
        err.raw = msg;
        throw err;
      }
    })();
    return loadingPromise;
  }

  // whisper 在没有人声时会吐 [BLANK_AUDIO] / [MUSIC] 这类占位串，当没听到处理
  function cleanText(t) {
    var s = String(t || '').trim();
    if (!s) return '';
    if (/^[\[\(（【].*[\]\)）】]$/.test(s)) return '';
    s = s.replace(/\[BLANK_AUDIO\]|\(silence\)|\[MUSIC\]|\[NOISE\]/gi, '').trim();
    return s;
  }

  async function transcribe(audio32) {
    var asr = await load();
    var t = performance.now();
    var out = await asr(audio32);
    return {
      text: cleanText(out && out.text),
      raw: String((out && out.text) || '').trim(),
      ms: Math.round(performance.now() - t),
    };
  }

  // ---------- 录音 ----------

  function resampleTo16k(input, fromRate) {
    if (fromRate === 16000) return input;
    var ratio = fromRate / 16000;
    var outLen = Math.floor(input.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(i0 + 1, input.length - 1);
      var frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  function micError(e) {
    var name = (e && e.name) || '';
    var err;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      err = new Error('麦克风权限被拦了。点地址栏左边的小锁，把「麦克风」改成允许，再试一次。');
      err.code = 'M_DENIED';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      err = new Error('这台设备没找到可用的麦克风。');
      err.code = 'M_NONE';
    } else if (name === 'NotReadableError') {
      err = new Error('麦克风被别的 App 占着，关掉它（比如语音通话）再试。');
      err.code = 'M_BUSY';
    } else {
      err = new Error('打不开麦克风：' + ((e && e.message) || name || '未知原因'));
      err.code = 'M_FAIL';
    }
    return err;
  }

  // 录一段话：自动检测说话开始与停顿结束
  // opts: { maxMs, silenceMs, threshold, onLevel, noSpeechMs }
  async function record(opts) {
    opts = opts || {};
    var maxMs = opts.maxMs || 15000;
    var silenceMs = opts.silenceMs || 1200;
    var threshold = opts.threshold || 0.014;
    if (!hasMic()) {
      var ne = new Error('这个浏览器拿不到麦克风（不支持录音接口）。');
      ne.code = 'M_UNSUPPORTED';
      throw ne;
    }

    // 有些浏览器会把「等你点允许」的框挂在那儿不给回调，必须自己设个上限，
    // 否则界面永远停在「正在听」
    var stream;
    try {
      stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
        new Promise(function (_, reject) {
          setTimeout(function () {
            var te = new Error('还没拿到麦克风权限。看一下地址栏左边的锁或屏幕上的提示，点「允许」再试。');
            te.code = 'M_WAIT';
            reject(te);
          }, opts.getUserMediaMs || 20000);
        }),
      ]);
    } catch (e) {
      throw (e && e.code === 'M_WAIT' ? e : micError(e));
    }

    var ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    } catch (e) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }

    var src = ctx.createMediaStreamSource(stream);
    var proc;
    try {
      proc = ctx.createScriptProcessor(4096, 1, 1);
    } catch (e) {
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e2) {}
      try { ctx.close(); } catch (e2) {}
      var pe = new Error('这个浏览器的录音接口被关掉了（createScriptProcessor 不可用）。换 Chrome / Edge 试试。');
      pe.code = 'M_UNSUPPORTED';
      throw pe;
    }
    var chunks = [];
    var startedAt = performance.now();
    var spoke = false;
    var lastVoiceAt = 0;

    return new Promise(function (resolve, reject) {
      var finished = false;
      var hardTimer = setTimeout(function () { finish('timeout'); }, maxMs + 900);
      // 没有音频回调（设备没输入）时也要能自己收尾
      var ticker = setInterval(function () {
        if (finished) return;
        var now2 = performance.now();
        if (!spoke && now2 - startedAt > (opts.noSpeechMs || 4000)) { finish('nospeech'); return; }
        if (spoke && lastVoiceAt && now2 - lastVoiceAt > silenceMs) { finish('silence'); return; }
        if (now2 - startedAt > maxMs) finish('timeout');
      }, 250);

      function cleanup() {
        clearTimeout(hardTimer);
        clearInterval(ticker);
        try { proc.disconnect(); } catch (e) {}
        try { src.disconnect(); } catch (e) {}
        try { ctx.close(); } catch (e) {}
        stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      }

      function finish(reason) {
        if (finished) return;
        finished = true;
        cleanup();
        var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
        var all = new Float32Array(total);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
        var rate = ctx.sampleRate || 16000;
        var audio = rate === 16000 ? all : resampleTo16k(all, rate);
        resolve({
          audio: audio,
          ok: !!spoke && audio.length > 1600,
          seconds: Math.round((audio.length / 16000) * 10) / 10,
          reason: reason,
          spoke: spoke,
        });
      }

      proc.onaudioprocess = function (ev) {
        if (finished) return;
        var buf = ev.inputBuffer.getChannelData(0);
        var copy = new Float32Array(buf.length);
        copy.set(buf);
        chunks.push(copy);

        var sum = 0;
        for (var i = 0; i < copy.length; i++) sum += copy[i] * copy[i];
        var rms = Math.sqrt(sum / copy.length);
        if (opts.onLevel) { try { opts.onLevel(rms); } catch (e) {} }

        var now = performance.now();
        if (rms > threshold) {
          if (!spoke) spoke = true;
          lastVoiceAt = now;
        } else if (spoke && lastVoiceAt && now - lastVoiceAt > silenceMs) {
          finish('silence');
          return;
        }
        if (!spoke && now - startedAt > (opts.noSpeechMs || 4000)) {
          finish('nospeech');
          return;
        }
        if (now - startedAt > maxMs) finish('timeout');
      };

      src.connect(proc);
      proc.connect(ctx.destination);
    });
  }

  // ---------- 手机自带识别（Web Speech API） ----------

  function srError(code) {
    var map = {
      'not-allowed': ['S_DENIED', '麦克风权限被拦了，允许之后再试。'],
      'service-not-allowed': ['S_DENIED', '这台设备不允许网页用识别服务。'],
      'no-speech': ['S_NOSPEECH', '没听到声音。'],
      network: ['S_NET', '手机自带识别要联网，现在连不上（国内网络常见）。'],
      'audio-capture': ['S_MIC', '抓不到麦克风的声音。'],
      aborted: ['S_ABORT', '这一次被中断了。'],
      'language-not-supported': ['S_LANG', '这台设备的识别不支持英语。'],
      'start-failed': ['S_START', '识别没能启动。'],
      timeout: ['S_TIMEOUT', '没听到你说话，我停了。'],
    };
    var m = map[code] || ['S_FAIL', '手机自带识别出错（' + code + '）。'];
    var e = new Error(m[1]);
    e.code = m[0];
    e.raw = code;
    return e;
  }

  function browserListen(opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var C = srCtor();
      if (!C) {
        var e0 = new Error('这个浏览器不带语音识别接口。');
        e0.code = 'S_UNSUPPORTED';
        return reject(e0);
      }
      var r;
      try {
        r = new C();
      } catch (e) {
        return reject(srError('start-failed'));
      }
      r.lang = 'en-US';
      r.interimResults = false;
      r.continuous = false;
      r.maxAlternatives = 1;

      var done = false;
      var t0 = performance.now();
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { r.abort(); } catch (e) {}
        reject(srError('timeout'));
      }, opts.maxMs || 12000);

      function done_() {
        done = true;
        clearTimeout(timer);
        try { r.onresult = null; r.onerror = null; r.onend = null; } catch (e) {}
      }

      r.onresult = function (ev) {
        if (done) return;
        var txt = '';
        try {
          for (var i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
        } catch (e) {}
        done_();
        var text = String(txt || '').trim();
        if (!text) return reject(srError('no-speech'));
        resolve({ text: text, engine: 'browser', ms: Math.round(performance.now() - t0), seconds: 0 });
      };
      r.onerror = function (ev) {
        if (done) return;
        done_();
        reject(srError((ev && ev.error) || 'error'));
      };
      r.onend = function () {
        if (done) return;
        done_();
        reject(srError('no-speech'));
      };
      try {
        r.start();
      } catch (e) {
        done_();
        reject(srError('start-failed'));
      }
    });
  }

  // ---------- 统一入口 ----------
  // opts: { engine:'auto'|'browser'|'local', prefer:'speed'|'accuracy', maxMs, onLevel, onStage }
  // 返回 { text, engine, ms, seconds }
  async function listen(opts) {
    opts = opts || {};
    var p = opts.engine || pref();
    var order;
    if (p === 'browser') order = ['browser', 'local'];
    else if (p === 'local') order = ['local'];
    else if (srCtor() && opts.prefer === 'speed') order = ['browser', 'local'];
    else order = ['local', 'browser'];

    var tries = [];
    var lastErr = null;
    for (var i = 0; i < order.length; i++) {
      var eng = order[i];
      if (opts.onStage) { try { opts.onStage(eng); } catch (e) {} }
      try {
        if (eng === 'browser') {
          if (opts.onStage) { try { opts.onStage('browser:record'); } catch (e) {} }
          var b = await browserListen({ maxMs: opts.maxMs || 12000 });
          b.tried = tries;
          return b;
        }
        if (!pipe && opts.onStage) { try { opts.onStage('local:load'); } catch (e) {} }
        if (opts.onStage) { try { opts.onStage('local:record'); } catch (e) {} }
        var rec = await record({
          maxMs: opts.maxMs || 15000,
          onLevel: opts.onLevel,
          noSpeechMs: opts.noSpeechMs,
          silenceMs: opts.silenceMs,
        });
        if (!rec.spoke || !rec.audio || rec.audio.length < 1600) {
          var ne = new Error(rec.reason === 'nospeech' ? '没听到你说英语，再说一次？' : '这次没录上声音。');
          ne.code = 'S_NOSPEECH';
          throw ne;
        }
        if (opts.onStage) { try { opts.onStage('local:transcribe'); } catch (e) {} }
        var out = await transcribe(rec.audio);
        if (!out.text) {
          var te = new Error('这句没听清，靠近一点再说一次。');
          te.code = 'S_EMPTY';
          throw te;
        }
        return { text: out.text, engine: 'local', ms: out.ms, seconds: rec.seconds, tried: tries };
      } catch (e) {
        lastErr = e;
        tries.push(eng + ':' + (e.code || e.message));
        // 权限被拒 / 没麦克风：换引擎也没用，直接报
        if (e.code === 'M_DENIED' || e.code === 'M_UNSUPPORTED' || e.code === 'S_DENIED' || e.code === 'M_NONE') break;
        // 用户确实没说话：别自动换引擎，会让人等两遍
        if (e.code === 'S_NOSPEECH' && eng === 'local') break;
      }
    }
    var err = lastErr || new Error('语音没跑起来。');
    err.tried = tries;
    throw err;
  }

  // ---------- 语音包预下载（分段并发 + 塞进 Cache Storage） ----------

  // 全桶找：模型文件在 asr 桶里，wasm 可能被 Service Worker 塞进页面缓存桶
  async function hasCached(url) {
    if (!window.caches) return false;
    try {
      var hit = await caches.match(url);
      return !!hit;
    } catch (e) {
      return false;
    }
  }

  async function checkCache(onItem) {
    var got = 0;
    for (var i = 0; i < PACK.length; i++) {
      var y = await hasCached(PACK[i].url);
      if (y) got += PACK[i].mb;
      if (onItem) { try { onItem(PACK[i], y); } catch (e) {} }
    }
    cacheFlag = got >= PACK_MB - 1;
    return { cachedMb: Math.round(got * 10) / 10, totalMb: Math.round(PACK_MB * 10) / 10, complete: cacheFlag };
  }

  // 带「卡住就放弃」的保护：超过 stallMs 没有新数据就自己中断
  async function fetchWithStall(url, opts, stallMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var opts2 = Object.assign({}, opts || {});
    if (ctrl) opts2.signal = ctrl.signal;
    var timer = null;
    function bump() {
      if (!ctrl) return;
      clearTimeout(timer);
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, stallMs || 25000);
    }
    bump();
    try {
      var res = await fetch(url, opts2);
      return { res: res, bump: bump, done: function () { clearTimeout(timer); } };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // 镜像（jsDelivr 这类跨域源）：整包一次 GET + 读流报进度。
  // 别对它发 Range —— 实测 jsDelivr 对非 0 起点的 Range 会一直挂着不下来。
  async function grabStream(src, targetUrl, onProgress) {
    var h = await fetchWithStall(src, null, 25000);
    var res = h.res;
    if (!res.ok) { h.done(); throw new Error('HTTP ' + res.status); }
    var total = Number(res.headers.get('Content-Length') || 0);
    var chunks = [];
    var got = 0;
    if (res.body && res.body.getReader) {
      var reader = res.body.getReader();
      for (;;) {
        var st = await reader.read();
        if (st.done) break;
        h.bump();
        chunks.push(st.value);
        got += st.value.byteLength;
        if (onProgress && total) onProgress(Math.min(0.99, got / total));
      }
    } else {
      var buf = await res.arrayBuffer();
      chunks.push(new Uint8Array(buf));
      got = buf.byteLength;
    }
    h.done();
    if (!got) throw new Error('空文件');
    await putBlob(targetUrl, new Blob(chunks, { type: 'application/octet-stream' }));
    if (onProgress) onProgress(1);
    return got;
  }

  // 同源（GitHub Pages 单流很慢）：拿 Range 总量 → 分段并发（带重试）
  async function grabRange(src, targetUrl, onProgress) {
    var suffix = src.charAt(0) === '.' ? '?pf=1' : '';
    var probe = await fetch(src + suffix, { headers: { Range: 'bytes=0-0' } });
    if (!probe.ok && probe.status !== 206) throw new Error('HTTP ' + probe.status);

    var total = 0;
    var cr = probe.headers.get('Content-Range');
    if (probe.status === 206 && cr) {
      var mm = /\/(\d+)\s*$/.exec(cr);
      if (mm) total = Number(mm[1]);
    }
    if (probe.status === 200) {
      var blob0 = await probe.blob();
      if (!blob0.size) throw new Error('空文件');
      await putBlob(targetUrl, blob0);
      if (onProgress) onProgress(1);
      return blob0.size;
    }
    try { probe.body && probe.body.cancel && probe.body.cancel(); } catch (e) {}
    if (!total) throw new Error('读不到文件大小');

    var CHUNK = 3 * 1024 * 1024;
    var CONC = 4;
    var parts = new Array(Math.ceil(total / CHUNK));
    var next = 0;
    var doneBytes = 0;

    async function fetchChunk(idx) {
      var start = idx * CHUNK;
      var end = Math.min(total - 1, start + CHUNK - 1);
      var lastErr = null;
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          var h = await fetchWithStall(src + suffix, { headers: { Range: 'bytes=' + start + '-' + end } }, 30000);
          if (h.res.status !== 206) { h.done(); throw new Error('HTTP ' + h.res.status); }
          var ab = await h.res.arrayBuffer();
          h.done();
          return ab;
        } catch (e) {
          lastErr = e;
          await new Promise(function (r) { setTimeout(r, 500 * (attempt + 1)); });
        }
      }
      throw lastErr || new Error('分段失败');
    }

    async function worker() {
      for (;;) {
        var idx = next++;
        if (idx >= parts.length) return;
        parts[idx] = await fetchChunk(idx);
        doneBytes += parts[idx].byteLength;
        if (onProgress) onProgress(Math.min(0.99, doneBytes / total));
      }
    }

    var ws = [];
    for (var k = 0; k < CONC; k++) ws.push(worker());
    await Promise.all(ws);

    var blob = new Blob(parts, { type: 'application/octet-stream' });
    if (blob.size !== total) throw new Error('拼装后大小不对（' + blob.size + '/' + total + '）');
    await putBlob(targetUrl, blob);
    if (onProgress) onProgress(1);
    return blob.size;
  }

  function isCrossOrigin(src) {
    return src.indexOf('http://') === 0 || src.indexOf('https://') === 0;
  }

  // 分片：每片独立走「镜像优先」，按顺序拼起来塞进缓存（30MB 的 decoder 靠这个绕开 20MB 上限）
  async function grabParts(item, onProgress) {
    var blobs = [];
    for (var i = 0; i < item.parts.length; i++) {
      var part = item.parts[i];
      var base = i / item.parts.length;
      await grab(
        { url: part.url, mirrors: part.mirrors || [] },
        (function (b) {
          return function (r) { if (onProgress) onProgress(b + r / item.parts.length); };
        })(base)
      );
      var c = await caches.open(CACHE_NAME);
      var hit = await c.match(part.url);
      if (!hit) throw new Error('分片没下到：' + part.url);
      blobs.push(await hit.blob());
    }
    var out = new Blob(blobs, { type: 'application/octet-stream' });
    if (!out.size) throw new Error('拼装为空');
    await putBlob(item.url, out);
    if (onProgress) onProgress(1);
    return 'parts(' + blobs.length + ')';
  }

  // 依次试镜像，最后回落同源；全部失败才报错
  async function grab(item, onProgress) {
    if (await hasCached(item.url)) {
      if (onProgress) onProgress(1);
      return 'cache';
    }
    if (item.parts && item.parts.length) return grabParts(item, onProgress);
    var sources = (item.mirrors || []).concat([item.url]);
    var lastErr = null;
    for (var i = 0; i < sources.length; i++) {
      try {
        if (isCrossOrigin(sources[i])) await grabStream(sources[i], item.url, onProgress);
        else await grabRange(sources[i], item.url, onProgress);
        return sources[i] === item.url ? 'origin' : 'mirror';
      } catch (e) {
        lastErr = e;
        if (onProgress) onProgress(0);
      }
    }
    throw lastErr || new Error('下载失败');
  }

  async function putBlob(url, blob) {
    if (!window.caches) return;
    var c = await caches.open(CACHE_NAME);
    await c.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }));
  }

  // 下载整包：onProgress({doneMb, totalMb, file, pct, from})
  async function prefetchPack(onProgress) {
    var doneMb = 0;
    var froms = {};
    for (var i = 0; i < PACK.length; i++) {
      var f = PACK[i];
      var base = doneMb;
      if (onProgress) onProgress({ doneMb: base, totalMb: PACK_MB, file: f.url.split('/').pop(), pct: (base / PACK_MB) * 100 });
      var from = await grab(f, function (r) {
        if (onProgress) {
          onProgress({
            doneMb: base + f.mb * r,
            totalMb: PACK_MB,
            file: f.url.split('/').pop(),
            pct: ((base + f.mb * r) / PACK_MB) * 100,
          });
        }
      });
      froms[from] = (froms[from] || 0) + 1;
      doneMb += f.mb;
    }
    cacheFlag = true;
    if (onProgress) onProgress({ doneMb: PACK_MB, totalMb: PACK_MB, file: '', pct: 100 });
    return { doneMb: Math.round(PACK_MB * 10) / 10, totalMb: Math.round(PACK_MB * 10) / 10, froms: froms };
  }

  // ---------- 诊断 ----------

  function diagnose() {
    var wasmOk = false;
    try { wasmOk = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'; } catch (e) {}
    return {
      mic: hasMic(),
      secure: !!window.isSecureContext,
      sr: !!srCtor(),
      wasm: wasmOk,
      pref: pref(),
      state: state,
      error: lastError,
      errorCode: lastErrorCode,
      cached: cacheFlag,
      packMb: Math.round(PACK_MB),
      cores: navigator.hardwareConcurrency || 0,
      ua: navigator.userAgent,
    };
  }

  function describeCode(code, raw) {
    if (code === 'L_WASM') return '语音引擎（wasm）没加载起来：' + (raw || '').slice(0, 120);
    if (code === 'L_NET') return '语音包下载失败，检查下网络再试（第一次要下约 ' + Math.round(PACK_MB) + 'MB）。';
    if (code === 'L_QUOTA') return '手机空间不够存语音包，清一点空间再试。';
    return '语音模型没加载上：' + (raw || '').slice(0, 120);
  }

  function describe(e) {
    if (!e) return '语音出错。';
    if (e.code === 'S_NOSPEECH') return '没听到你说话。';
    return String(e.message || e);
  }

  // ---------- 打分 ----------

  var NUMBER_WORDS = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
    eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
    fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
    thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
    hundred: '100', thousand: '1000',
  };

  function tokenize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\u2019\u2018]/g, "'")
      .replace(/[^a-z0-9'\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function canon(w) {
    var base = w.replace(/'s$/, '');
    return NUMBER_WORDS[base] || base;
  }

  function alignFlags(target, heard) {
    var n = target.length;
    var m = heard.length;
    var ok = new Array(n);
    for (var z = 0; z < n; z++) ok[z] = false;
    if (!n || !m) return ok;
    var dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = target[i] === heard[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    i = 0;
    var j2 = 0;
    while (i < n && j2 < m) {
      if (target[i] === heard[j2]) { ok[i] = true; i++; j2++; }
      else if (dp[i + 1][j2] >= dp[i][j2 + 1]) i++;
      else j2++;
    }
    return ok;
  }

  function scoreReading(targetText, heardText) {
    var T = tokenize(targetText).map(canon);
    var H = tokenize(heardText).map(canon);
    var ok = alignFlags(T, H);
    var matched = ok.filter(Boolean).length;
    var total = T.length || 1;
    var coverage = matched / total;
    var extra = Math.max(0, H.length - matched);
    var score = Math.round(coverage * 100);
    if (extra > 0) score -= Math.min(15, extra * 3);
    score = Math.max(0, Math.min(100, score));
    var label, tone;
    if (score >= 90) { label = '说得很准'; tone = 'great'; }
    else if (score >= 75) { label = '不错，再顺一点'; tone = 'good'; }
    else if (score >= 60) { label = '有几个词含糊'; tone = 'ok'; }
    else { label = '再听一遍示范吧'; tone = 'bad'; }
    return {
      score: score,
      label: label,
      tone: tone,
      words: T.map(function (w, i) { return { w: w, ok: ok[i] }; }),
      matched: matched,
      total: T.length,
      extra: extra,
      heard: H.join(' '),
    };
  }

  window.ASR = {
    load: load,
    transcribe: transcribe,
    record: record,
    listen: listen,
    browserListen: browserListen,
    hasBrowserSR: function () { return !!srCtor(); },
    setProgressHook: function (fn) { progressHook = fn; },
    prefetchPack: prefetchPack,
    checkCache: checkCache,
    packMb: Math.round(PACK_MB),
    diagnose: diagnose,
    describe: describe,
    pref: pref,
    setPref: setPref,
    scoreReading: scoreReading,
    tokenize: tokenize,
    hasMic: hasMic,
    get state() { return state; },
    get error() { return lastError; },
    get errorCode() { return lastErrorCode; },
    get ready() { return !!pipe; },
    get cached() { return cacheFlag; },
  };
})();

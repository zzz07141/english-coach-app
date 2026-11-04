// 本地语音识别 + 跟读打分
// 模型 whisper-tiny.en（量化 ONNX，约 42MB）与页面同源，放站点根 whisper-tiny.en/
// 库用同源 vendor/transformers.min.js（ESM），避免依赖外网 CDN
(function () {
  'use strict';

  var MODEL_ID = 'whisper-tiny.en';
  var LIB_URL = './vendor/transformers.min.js';
  var MODEL_BASE = './';
  var CACHE_NAME = 'english-coach-asr-v1';

  var pipe = null;
  var loadingPromise = null;
  var state = 'idle'; // idle | loading | ready | failed
  var lastError = '';

  function setState(s, err) {
    state = s;
    if (err) lastError = String(err && err.message ? err.message : err);
  }

  function hasMic() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async function loadLib() {
    var mod = await import(LIB_URL);
    mod.env.allowRemoteModels = false;
    mod.env.allowLocalModels = true;
    mod.env.localModelPath = MODEL_BASE;
    return mod;
  }

  // 把已下载的文件塞进 Cache Storage，下次直接命中
  function rememberResponse(url, res) {
    if (!res || !res.ok || !window.caches) return;
    try {
      caches.open(CACHE_NAME).then(function (c) { c.put(url, res.clone()); }).catch(function () {});
    } catch (e) {}
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
          progress_callback: function (p) {
            try {
              if (onProgress) onProgress(p);
            } catch (e) {}
          },
        });
        pipe = asr;
        setState('ready');
        return asr;
      } catch (e) {
        setState('failed', e);
        loadingPromise = null;
        throw e;
      }
    })();
    return loadingPromise;
  }

  async function transcribe(audio32) {
    var asr = await load();
    var t = performance.now();
    var out = await asr(audio32);
    return {
      text: String((out && out.text) || '').trim(),
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

  // 录一段话：自动检测说话开始与停顿结束
  // opts: { maxMs, silenceMs, threshold, onLevel }
  async function record(opts) {
    opts = opts || {};
    var maxMs = opts.maxMs || 15000;
    var silenceMs = opts.silenceMs || 1200;
    var threshold = opts.threshold || 0.014;
    if (!hasMic()) throw new Error('这个浏览器拿不到麦克风');

    var stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    var ctx;
    try {
      ctx = new AudioContext({ sampleRate: 16000 });
    } catch (e) {
      ctx = new AudioContext();
    }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }

    var src = ctx.createMediaStreamSource(stream);
    var proc = ctx.createScriptProcessor(4096, 1, 1);
    var chunks = [];
    var startedAt = performance.now();
    var spoke = false;
    var lastVoiceAt = 0;

    return new Promise(function (resolve, reject) {
      var finished = false;
      var hardTimer = setTimeout(function () { finish('timeout'); }, maxMs + 500);
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
        var audio = ctx.sampleRate === 16000 ? all : resampleTo16k(all, ctx.sampleRate);
        resolve({
          audio: audio,
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
        // 一直没人说话：别让用户干等
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

  // 最长公共子序列对齐：返回目标句每个词是否被说中
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
    scoreReading: scoreReading,
    tokenize: tokenize,
    hasMic: hasMic,
    get state() { return state; },
    get error() { return lastError; },
    get ready() { return !!pipe; },
  };
})();

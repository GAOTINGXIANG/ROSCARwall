/**
 * ROSCAR 留言墙 —— 方案 A
 * 读取：匿名请求 GitHub Issues API（60 次/小时/IP）
 * 发布：跳转 GitHub 新建 Issue 页面，由用户本人提交
 */
(function () {
  'use strict';

  /* ---------------- 配置 ---------------- */
  var DEFAULTS = {
    owner: 'your-github-name',
    repo: 'ROSCARwall',
    label: '',
    pollMs: 90000,
    pageSize: 50
  };
  var CFG = Object.assign({}, DEFAULTS, window.WALL_CONFIG || {});
  var IS_DEMO = !CFG.owner || CFG.owner === 'your-github-name';
  var REPO_URL = 'https://github.com/' + CFG.owner + '/' + CFG.repo;
  var API_URL = 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo + '/issues'
    + '?state=open&per_page=' + CFG.pageSize
    + '&sort=created&direction=desc'
    + (CFG.label ? '&labels=' + encodeURIComponent(CFG.label) : '');
  var CACHE_KEY = 'roscar-wall:' + CFG.owner + '/' + CFG.repo;
  var POLL_MS = Math.max(30000, Number(CFG.pollMs) || 90000);

  /* ---------------- DOM ---------------- */
  function $(id) { return document.getElementById(id); }
  var el = {
    wall: $('wall'),
    card: $('card'),
    empty: $('empty'),
    skeletons: $('skeletons'),
    banner: $('banner'),
    status: $('status'),
    statusText: $('status-text'),
    count: $('message-count'),
    form: $('composer'),
    input: $('message'),
    counter: $('counter'),
    refresh: $('refresh'),
    repoLink: $('repo-link'),
    issuesLink: $('issues-link'),
    footLink: $('foot-link'),
    toast: $('toast')
  };

  var state = {
    list: [],
    busy: false,
    lastSync: 0,
    cooldownUntil: 0
  };
  var pendingReload = false;
  var toastTimer = 0;

  /* ---------------- 演示数据 ---------------- */
  function demoMessages() {
    var now = Date.now();
    var H = 3600000;
    return [
      {
        number: 12,
        text: '今天第一次把 ROS 小车跑通，从建图到导航全程没撞墙，感谢实验室各位的帮助！',
        login: 'roscar-demo',
        avatar: '',
        time: new Date(now - H * 3).toISOString(),
        url: '',
        likes: 7,
        comments: 2
      },
      {
        number: 11,
        text: '招新答疑：想加入视觉组的同学可以先把 OpenCV 的基础例程跑一遍，欢迎来实验室聊。',
        login: 'vision-lab',
        avatar: '',
        time: new Date(now - H * 26).toISOString(),
        url: '',
        likes: 15,
        comments: 4
      },
      {
        number: 10,
        text: '走廊的充电器是谁的？已经帮你们收到柜子第二层了。',
        login: 'night-owl',
        avatar: '',
        time: new Date(now - H * 50).toISOString(),
        url: '',
        likes: 3,
        comments: 0
      }
    ];
  }

  /* ---------------- 工具 ---------------- */
  function relTime(value) {
    var ts = typeof value === 'number' ? value : new Date(value).getTime();
    if (!ts || isNaN(ts)) return '';
    var diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
    return new Date(ts).toLocaleDateString('zh-CN');
  }

  function clock(ts) {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  }

  function setStatus(kind, text) {
    el.status.className = 'status' + (kind === 'ok' ? ' is-ok' : kind === 'err' ? ' is-err' : '');
    el.statusText.textContent = text;
  }

  function showBanner(text, warn) {
    el.banner.textContent = text;
    el.banner.className = 'banner' + (warn ? ' is-warn' : '');
    el.banner.hidden = false;
  }

  function hideBanner() {
    el.banner.hidden = true;
  }

  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('is-open');
    }, 4200);
  }

  /* ---------------- 缓存 ---------------- */
  function readCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function writeCache(list) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(list));
    } catch (e) { /* 隐私模式或超限时忽略 */ }
  }

  /* ---------------- 数据获取 ---------------- */
  function fetchMessages() {
    return fetch(API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 403 || res.status === 429) {
        var reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
        var minutes = reset > Date.now() ? Math.ceil((reset - Date.now()) / 60000) : 0;
        var err = new Error(minutes
          ? 'GitHub 接口限流，约 ' + minutes + ' 分钟后恢复'
          : 'GitHub 接口限流，请稍后再试');
        if (reset) err.retryAt = reset;
        throw err;
      }
      if (res.status === 404) {
        throw new Error('仓库不存在或未开启 Issues，请检查 config.js');
      }
      if (!res.ok) {
        throw new Error('GitHub 返回 ' + res.status);
      }
      return res.json();
    }).catch(function (err) {
      if (err instanceof TypeError) throw new Error('网络请求失败，请检查网络连接');
      throw err;
    }).then(function (data) {
      return data.filter(function (item) {
        if (item.pull_request) return false; // Issues 接口会把 PR 混进来
        if (CFG.label && !(item.labels || []).some(function (l) { return l.name === CFG.label; })) return false;
        return true;
      }).map(function (item) {
        return {
          number: item.number,
          text: item.title,
          login: item.user ? item.user.login : 'ghost',
          avatar: item.user ? item.user.avatar_url : '',
          time: item.created_at,
          url: item.html_url,
          likes: item.reactions ? item.reactions['+1'] : 0,
          comments: item.comments || 0
        };
      });
    });
  }

  /* ---------------- 渲染 ---------------- */
  function render(list) {
    var frag = document.createDocumentFragment();

    list.forEach(function (m) {
      var node = el.card.content.firstElementChild.cloneNode(true);
      var avatar = node.querySelector('.avatar');
      var img = avatar.querySelector('img');
      if (m.avatar) {
        img.src = m.avatar;
        img.alt = m.login + ' 的头像';
      } else {
        img.remove();
      }
      avatar.querySelector('.avatar-ph').textContent = (m.login || '?').charAt(0).toUpperCase();

      node.querySelector('.name').textContent = m.login;

      var time = node.querySelector('.time');
      time.dateTime = m.time || '';
      time.dataset.ts = String(new Date(m.time).getTime() || '');
      time.textContent = relTime(m.time);

      node.querySelector('.text').textContent = m.text;

      var link = node.querySelector('.link');
      if (m.url) link.href = m.url;
      else link.removeAttribute('href');
      link.querySelector('.num').textContent = '#' + m.number;

      node.querySelector('.likes').textContent = '赞 ' + (m.likes || 0);
      var comments = node.querySelector('.comments');
      if (m.comments) comments.textContent = m.comments + ' 条回复';
      else comments.remove();

      frag.appendChild(node);
    });

    el.wall.replaceChildren(frag);
    el.count.textContent = String(list.length);
    el.empty.hidden = list.length > 0;
  }

  function refreshTimes() {
    el.wall.querySelectorAll('.time').forEach(function (node) {
      var ts = Number(node.dataset.ts);
      if (ts) node.textContent = relTime(ts);
    });
  }

  /* ---------------- 加载流程 ---------------- */
  function load(options) {
    options = options || {};
    if (state.busy) return Promise.resolve();
    if (!options.force && Date.now() < state.cooldownUntil) return Promise.resolve();

    state.busy = true;
    el.refresh.disabled = true;

    var task = IS_DEMO ? Promise.resolve(demoMessages()) : fetchMessages();

    return task.then(function (list) {
      state.list = list;
      render(list);
      if (!IS_DEMO) writeCache(list);
      state.lastSync = Date.now();
      setStatus(IS_DEMO ? 'idle' : 'ok', IS_DEMO ? '演示数据' : '已同步 ' + clock(state.lastSync));
      if (!IS_DEMO) hideBanner();
    }).catch(function (err) {
      setStatus('err', '同步失败');
      if (err.retryAt) state.cooldownUntil = err.retryAt;
      var suffix = state.list.length ? '，当前显示的是上次内容' : '';
      showBanner(err.message + suffix + '。可稍后点击「刷新」重试。', true);
    }).then(function () {
      state.busy = false;
      el.refresh.disabled = false;
      el.skeletons.hidden = true;
    });
  }

  /* ---------------- 交互 ---------------- */
  function bindEvents() {
    el.input.addEventListener('input', function () {
      var n = el.input.value.length;
      el.counter.textContent = n + ' / 256';
      el.counter.classList.toggle('is-full', n >= 256);
    });

    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = el.input.value.replace(/\s+/g, ' ').trim();
      if (!text) {
        el.input.focus();
        toast('先写点什么再发布吧');
        return;
      }
      if (IS_DEMO) {
        toast('当前是演示模式，请先在 config.js 中填写仓库信息');
        return;
      }
      var url = REPO_URL + '/issues/new?title=' + encodeURIComponent(text.slice(0, 256));
      window.open(url, '_blank', 'noopener');
      toast('已打开 GitHub，请点击 “Submit new issue” 完成发布');
      pendingReload = true;
    });

    el.refresh.addEventListener('click', function () {
      load({ force: true });
    });

    // 从 GitHub 发帖页面返回时自动刷新一次
    window.addEventListener('focus', function () {
      if (!pendingReload) return;
      pendingReload = false;
      setTimeout(function () { load({ force: true }); }, 1500);
    });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (IS_DEMO) {
      el.repoLink.hidden = true;
      el.issuesLink.hidden = true;
      el.footLink.hidden = true;
    } else {
      el.repoLink.href = REPO_URL;
      el.issuesLink.href = REPO_URL + '/issues';
      el.footLink.href = REPO_URL + '/issues';
    }

    var cached = readCache();
    if (!IS_DEMO && cached && cached.length) {
      state.list = cached;
      render(cached);
    }

    bindEvents();
    load();

    if (IS_DEMO) {
      showBanner('当前显示的是演示留言。把 config.js 里的 owner / repo 改成你自己的仓库，即可读取真实 Issue。');
    }

    // 轮询：页面隐藏、请求进行中或处于限流冷却期时跳过
    setInterval(function () {
      if (IS_DEMO || state.busy) return;
      if (document.visibilityState !== 'visible') return;
      if (Date.now() < state.cooldownUntil) return;
      load();
    }, POLL_MS);

    // 回到前台时补一次刷新
    document.addEventListener('visibilitychange', function () {
      if (IS_DEMO || document.visibilityState !== 'visible') return;
      if (Date.now() - state.lastSync > 15000) load();
    });

    // 每分钟更新相对时间
    setInterval(refreshTimes, 60000);
  }

  boot();
})();

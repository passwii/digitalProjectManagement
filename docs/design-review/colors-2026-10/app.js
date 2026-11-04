/* 预览页交互：方案 / 主题切换 + 色卡与对比度渲染 */
(function () {
  var D = window.__COLORS__;
  var order = ['current', 'a', 'b', 'c', 'd'];

  var COPY = {
    current: {
      take: '深海蓝底 + 电光青信号 + 荧光青柠行动。',
      good: ['深色下辨识度极高，远看就知道是这套系统', '科技感与品牌记忆点明确'],
      care: ['五个语义角色同时处于高亮档，界面没有主次', '青 / 蓝 / 水绿三个冷色在图表里几乎分不开', '浅色主题是另一套性格：品牌从电光青变成钢蓝绿'],
    },
    a: {
      take: '石墨中性表面，靛蓝是唯一的强调色，颜色只负责指路。',
      good: ['长时间阅读不累，表格与数字层级最清楚', '深浅两套主题同一性格，只变明度', '接入成本最低：蓝 → 靛蓝是同类替换'],
      care: ['个性靠版式与密度，不靠颜色；品牌辨识度需要重新经营'],
    },
    b: {
      take: '保留深海青作为品牌基因但压掉霓虹，主按钮从荧光青柠换成纸白中性。',
      good: ['品牌延续性最强，与「雾白与深海蓝」的既有方向一致', '青只出现在信号位置，不再与行动色抢戏', '纸白主按钮在深色上质感最好，且与所有状态徽标都能并存'],
      care: ['浅色主题的主按钮要换成墨青（同一职责两套明度），需要在规范里写清'],
    },
    c: {
      take: '墨玉单色系承载信号与完成，黄铜只做行动与点缀，账本式的稳。',
      good: ['暖中性底比蓝底耐看，适合财务与台账的长时段使用', '黄铜行动色有辨识度但不刺眼', '数字与状态读起来像报表而不是仪表盘'],
      care: ['暖色系（铜 / 琥珀 / 砖红）色相接近，只能以小面积徽标出现，不能放大填充'],
    },
    d: {
      take: '整套系统只剩一个强调色；主次靠填充、描边与文字三种形态区分。',
      good: ['颜色最少、最不容易乱，新页面不需要再讨论「这个用什么色」', '主按钮 = 品牌色填充，语义最直白，也最容易在深浅主题间保持一致', '落地改动最小：不用重新选一整套色相，只拆职责 + 去掉青柠'],
      care: ['强调色在深色底上用满高亮，需要靠面积与位置控制，不能用在大色块上'],
    },
  };
  var PICK = { b: '推荐主线', d: '改动最小', a: '最稳' };

  var state = { p: 'current', mode: 'dark' };

  function meta(p, mode) { return D.meta[p + ':' + mode]; }
  function sw(p, mode) { return D.palettes[p].swatches[mode]; }

  /* ---------- 顶部方案按钮 ---------- */
  var swWrap = document.getElementById('paletteSwitch');
  order.forEach(function (k) {
    var s = sw(k, 'dark');
    var b = document.createElement('button');
    b.type = 'button';
    b.dataset.p = k;
    b.innerHTML = '<span class="sw" style="background:' + s['brand'] + '"></span>' +
      (k === 'current' ? '现状' : k.toUpperCase() + ' · ' + D.palettes[k].name.replace(/^[A-D] · /, ''));
    b.addEventListener('click', function () { set({ p: k }); });
    swWrap.appendChild(b);
  });

  /* ---------- 主题按钮 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('#modeSwitch button'), function (b) {
    b.addEventListener('click', function () { set({ mode: b.dataset.mode }); });
  });

  /* ---------- 方案卡 ---------- */
  var cards = document.getElementById('cards');
  order.forEach(function (k) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'pcard';
    card.dataset.p = k;
    card.addEventListener('click', function () { set({ p: k }); });
    cards.appendChild(card);
  });

  function renderCards() {
    Array.prototype.forEach.call(cards.children, function (card) {
      var k = card.dataset.p;
      var s = sw(k, state.mode);
      var m = meta(k, state.mode);
      var st = D.struct[k + ':' + state.mode];
      var keys = ['bg', 'card', 'brand', 'action', 'done', 'warn', 'danger'];
      card.setAttribute('aria-pressed', k === state.p ? 'true' : 'false');
      card.innerHTML =
        '<div class="top"><span class="name">' + (k === 'current' ? '现状' : D.palettes[k].name) + '</span>' +
        '<span class="tag">' + (PICK[k] || '') + '</span></div>' +
        '<div class="sw-row">' + keys.map(function (key) {
          return '<i style="background:' + s[key] + '"' + (key === 'bg' ? ' class="first"' : '') + '></i>';
        }).join('') + '</div>' +
        '<div class="desc">' + COPY[k].take + '</div>' +
        '<div class="ratio"><span>不达标 <b>' + st.fails + '</b></span>' +
        '<span>高亮角色 <b>' + m.loudRoles.length + '</b></span>' +
        '<span>系列间距 <b>' + (m.seriesMinGap == null ? '—' : m.seriesMinGap + '°') + '</b></span></div>';
    });
  }

  /* ---------- 说明条 ---------- */
  function renderRationale() {
    var c = COPY[state.p];
    var box = document.getElementById('rationale');
    box.innerHTML =
      '<div class="rat"><h4>这套在做什么</h4><p>' + c.take + '</p></div>' +
      '<div class="rat"><h4>好在哪</h4><p>' + c.good.join('；') + '。</p></div>' +
      '<div class="rat"><h4>要接受什么</h4><p class="bad">' + c.care.join('；') + '。</p></div>';
  }

  /* ---------- 对比度表 ---------- */
  function renderTables() {
    var rows = {};
    D.contrast.text.forEach(function (r) {
      if (r.palette !== state.p) return;
      (rows[r.label] = rows[r.label] || {})[r.mode] = r;
    });
    var html = '<thead><tr><th>项</th><th style="width:74px">深色</th><th style="width:74px">浅色</th><th style="width:52px">下限</th></tr></thead><tbody>';
    Object.keys(rows).forEach(function (label) {
      var d = rows[label].dark, l = rows[label].light;
      html += '<tr><td>' + label + '</td>' +
        '<td class="mono ' + (d.ok ? 'ok' : 'bad') + '">' + d.ratio.toFixed(2) + ':1</td>' +
        '<td class="mono ' + (l.ok ? 'ok' : 'bad') + '">' + l.ratio.toFixed(2) + ':1</td>' +
        '<td class="mono">4.5</td></tr>';
    });
    document.getElementById('textTable').innerHTML = html + '</tbody>';
    document.getElementById('txthd').textContent = D.palettes[state.p].name;

    var g = {};
    D.contrast.graphic.forEach(function (r) {
      if (r.palette !== state.p) return;
      (g[r.label] = g[r.label] || {})[r.mode] = r;
    });
    var gh = '<thead><tr><th>项</th><th style="width:74px">深色</th><th style="width:74px">浅色</th><th style="width:52px">下限</th></tr></thead><tbody>';
    Object.keys(g).forEach(function (label) {
      var d = g[label].dark, l = g[label].light;
      gh += '<tr><td>' + label + '</td>' +
        '<td class="mono ' + (d.ok ? 'ok' : 'bad') + '">' + d.ratio.toFixed(2) + ':1</td>' +
        '<td class="mono ' + (l.ok ? 'ok' : 'bad') + '">' + l.ratio.toFixed(2) + ':1</td>' +
        '<td class="mono">3.0</td></tr>';
    });
    document.getElementById('graphicTable').innerHTML = gh + '</tbody>';
    document.getElementById('gfhd').textContent = D.palettes[state.p].name;
  }

  /* ---------- 横评表 ---------- */
  function renderCompare() {
    var LABELS = { current: '现状 · 青 + 蓝', a: 'A · 石墨靛蓝', b: 'B · 深海青 · 纸白', c: 'C · 墨玉 · 黄铜', d: 'D · 单一主色' };
    var head = '<thead><tr><th style="width:190px">指标 · 深色主题</th>' +
      order.map(function (k) {
        return '<th style="width:150px' + (k === state.p ? ';color:var(--ui-hi)' : '') + '">' + LABELS[k] + '</th>';
      }).join('') + '</tr></thead>';
    function row(name, fn) {
      return '<tr><td>' + name + '</td>' + order.map(function (k) {
        var v = fn(D.struct[k + ':dark'], k);
        var cls = v.bad ? 'bad' : '';
        return '<td class="mono ' + cls + '"' + (k === state.p ? ' style="color:var(--ui-hi)"' : '') + '>' + v.text + '</td>';
      }).join('') + '</tr>';
    }
    var body = '<tbody>' +
      row('对比度不达标项（共 ' + (D.contrast.text.length / 10 + D.contrast.graphic.length / 10) + ' 项检查）', function (s) { return { text: s.fails + ' 项', bad: s.fails > 0 }; }) +
      row('同一色值共用的语义角色（最多）', function (s) { return { text: s.maxShared + ' 个', bad: s.maxShared >= 3 }; }) +
      row('共用明细', function (s) { return { text: s.sharedGroups.length ? s.sharedGroups.join(' / ') : '无', bad: s.maxShared >= 3 }; }) +
      row('图表系列最小色相间距', function (s) { return { text: s.seriesMinGap + '°', bad: s.seriesMinGap < 40 }; }) +
      row('行动色与品牌色', function (s) { return { text: s.sameActionBrand ? '同色（形态区分）' : '相差 ' + s.actionVsBrandHue + '°', bad: false }; }) +
      row('高亮语义角色数', function (s, k) { var n = D.meta[k + ':dark'].loudRoles.length; return { text: n + ' 个', bad: n >= 5 }; }) +
      row('深色底色彩度（越低越中性）', function (s, k) { var c = D.meta[k + ':dark'].bgChroma; return { text: c.toFixed(3), bad: c > 0.015 }; }) +
      '</tbody>';
    document.getElementById('compareTable').innerHTML = head + body;
  }

  /* ---------- 令牌对照表 ---------- */
  var TOKEN_ROWS = [
    ['--bg', 'bg', '页面底色'], ['--card', 'card', '卡片 / 面板'], ['--card-lift', 'card-lift', '表头 / 抬升面'],
    ['--ink', 'ink', '主文字'], ['--ink-2', 'ink-2', '次级文字'], ['--ink-3', 'ink-3', '弱文字'],
    ['--line', 'line', '分隔线'], ['--control-border', 'control-border', '控件描边'],
    ['--brand', 'brand', '信号 / 链接 / 焦点'], ['--brand-soft', 'brand-soft', '信号软底'],
    ['--action', 'action', '主按钮底'], ['--on-action', 'on-action', '主按钮文字'], ['--action-line', 'action-line', '主按钮描边'],
    ['--doing', 'doing', '进行中'], ['--done', 'done', '完成'], ['--warn', 'warn', '警告'], ['--danger', 'danger', '危险'], ['--todo', 'todo', '中性状态'],
    ['--nav', 'nav', '侧栏底色'], ['--nav-ink', 'nav-ink', '侧栏文字'], ['--nav-active-accent', 'nav-active-accent', '导航当前项'],
    ['--series-1', 'series-1', '系列 1'], ['--series-2', 'series-2', '系列 2'], ['--series-3', 'series-3', '系列 3'],
    ['--series-4', 'series-4', '系列 4'], ['--series-5', 'series-5', '系列 5'], ['--series-6', 'series-6', '系列 6'],
  ];
  function renderTokens() {
    ['dark', 'light'].forEach(function (mode) {
      var card = sw(state.p, mode);
      var html = '<thead><tr><th style="width:26px"></th><th style="width:150px">令牌</th><th>角色</th><th style="width:110px">值</th></tr></thead><tbody>';
      TOKEN_ROWS.forEach(function (row) {
        var v = card[row[1]];
        var isColor = /^#|^rgba?\(/.test(String(v));
        html += '<tr><td class="sw">' + (isColor ? '<i style="background:' + v + '"></i>' : '') + '</td>' +
          '<td class="mono">' + row[0] + '</td><td>' + row[2] + '</td>' +
          '<td class="v">' + v + '</td></tr>';
      });
      document.getElementById(mode === 'dark' ? 'tokDark' : 'tokLight').innerHTML = html + '</tbody>';
      document.getElementById(mode === 'dark' ? 'tokDarkName' : 'tokLightName').textContent = D.palettes[state.p].name;
    });
  }

  /* ---------- 应用状态 ---------- */
  function apply() {
    document.body.dataset.p = state.p;
    document.body.dataset.mode = state.mode;
    Array.prototype.forEach.call(document.querySelectorAll('[data-preview]'), function (el) {
      el.dataset.p = state.p;
      el.dataset.mode = state.mode;
    });
    Array.prototype.forEach.call(swWrap.children, function (b) {
      b.setAttribute('aria-pressed', b.dataset.p === state.p ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('#modeSwitch button'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.mode === state.mode ? 'true' : 'false');
    });
    var name = state.p === 'current' ? '现状 · 青 + 蓝' : D.palettes[state.p].name;
    document.getElementById('stageName').textContent = COPY[state.p].take;
    document.getElementById('stageCur').textContent = name + ' · ' + (state.mode === 'dark' ? '深色' : '浅色');
    document.getElementById('frameCapName').textContent = name + ' — 工作台 / 项目台账';
    document.getElementById('frameCapMode').textContent = state.mode.toUpperCase();
    renderCards(); renderRationale(); renderTables(); renderCompare(); renderTokens();
    try { localStorage.setItem('dsh-color-review', JSON.stringify(state)); } catch (e) {}
    if (history.replaceState) history.replaceState(null, '', '#' + state.p + '-' + state.mode);
  }

  function set(patch) {
    Object.assign(state, patch);
    apply();
  }

  window.addEventListener('hashchange', function () {
    var parts = (location.hash || '').replace('#', '').split('-');
    if (order.indexOf(parts[0]) >= 0) state.p = parts[0];
    if (parts[1] === 'light' || parts[1] === 'dark') state.mode = parts[1];
    apply();
  });

  /* 键盘：1–5 切方案，t 切主题 */
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    var i = ['1', '2', '3', '4', '5'].indexOf(e.key);
    if (i >= 0) set({ p: order[i] });
    if (e.key === 't' || e.key === 'T') set({ mode: state.mode === 'dark' ? 'light' : 'dark' });
  });

  /* 初始化：hash > localStorage > 默认 */
  var restored = null;
  try { restored = JSON.parse(localStorage.getItem('dsh-color-review') || 'null'); } catch (e) {}
  var hash = (location.hash || '').replace('#', '').split('-');
  if (hash[0] && order.indexOf(hash[0]) >= 0) state.p = hash[0];
  else if (restored && order.indexOf(restored.p) >= 0) state.p = restored.p;
  if (hash[1] === 'light' || hash[1] === 'dark') state.mode = hash[1];
  else if (restored && (restored.mode === 'light' || restored.mode === 'dark')) state.mode = restored.mode;
  apply();
})();

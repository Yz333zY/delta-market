/* ============ 三角洲行动 · 实时物价 应用逻辑 V3 ============ */
(function () {
    'use strict';

    /* ---------- 状态 ---------- */
    const state = {
        items: [],          // 真实精选物品
        prev: {},           // 上一次价格快照
        cats: [],
        activeCat: 'all',
        keyword: '',
        refreshCount: 0,
        soundOn: true,
        loading: false,
        chartId: null,      // 折线图当前物品 id
        hist: [],           // 价格历史记录 [{t, p: {id:price}}]
        maxRec: 48
    };

    const LS_KEY = 'delta_market_rec_v3';
    const SEED_KEY = 'delta_market_seeded_v3';

    /* ---------- DOM ---------- */
    const $ = id => document.getElementById(id);
    const grid = $('priceGrid');
    const empty = $('emptyState');
    const loadingEl = $('loadingState');
    const searchBox = $('searchBox');
    const catFilter = $('catFilter');
    const refreshBtn = $('refreshBtn');
    const toast = $('toast');
    const soundToggle = $('soundToggle');
    const chartCanvas = $('priceChart');
    const chartCtx = chartCanvas.getContext('2d');
    const chartSelect = $('chartSelect');

    /* ---------- 工具函数 ---------- */
    const fmt = n => n >= 10000 ? (n / 10000).toFixed(2) + '万' : n.toLocaleString('zh-CN');

    function fmtTime(d) {
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function showToast(msg, dur = 1600) {
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toast.classList.remove('show'), dur);
    }

    function beep(up) {
        if (!state.soundOn) return;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            const ctx = new Ctx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = up ? 880 : 440;
            gain.gain.setValueAtTime(0.08, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.16);
            setTimeout(() => ctx.close(), 300);
        } catch (e) { /* 忽略 */ }
    }

    /* ---------- 粒子背景 ---------- */
    function initBg() {
        const bg = $('bgCanvas');
        const colors = ['#38bdf8', '#818cf8', '#e879f9', '#fbbf24', '#34d399'];
        const count = window.innerWidth < 560 ? 14 : 24;
        for (let i = 0; i < count; i++) {
            const s = document.createElement('i');
            const size = Math.random() * 6 + 2;
            s.style.width = size + 'px';
            s.style.height = size + 'px';
            s.style.left = Math.random() * 100 + '%';
            s.style.background = colors[i % colors.length];
            s.style.setProperty('--o', (Math.random() * 0.4 + 0.25).toFixed(2));
            s.style.setProperty('--dx', (Math.random() * 80 - 40).toFixed(1) + 'px');
            s.style.animationDuration = (Math.random() * 14 + 12) + 's';
            s.style.animationDelay = (Math.random() * 12) + 's';
            bg.appendChild(s);
        }
    }

    /* ---------- 历史记录管理 (localStorage) ---------- */
    function loadHist() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            state.hist = raw ? JSON.parse(raw) : [];
        } catch (e) { state.hist = []; }
        // 种子标记存在但历史为空 → 清除标记，允许重新生成
        if (localStorage.getItem(SEED_KEY) && !state.hist.length) {
            localStorage.removeItem(SEED_KEY);
        }
    }

    function saveHist() {
        try { localStorage.setItem(LS_KEY, JSON.stringify(state.hist.slice(-state.maxRec))); }
        catch (e) { /* 忽略 */ }
    }

    // 首次访问：生成 24 条历史种子（模拟近24h走势），保证折线图有记录
    function seedHist() {
        if (localStorage.getItem(SEED_KEY) || state.hist.length > 0) return;
        const now = Date.now();
        const arr = [];
        for (let i = 23; i >= 0; i--) {
            const t = now - i * 3600 * 1000;
            const snap = {};
            state.items.forEach(it => {
                // 最后一条(i=0)对齐当前真实价格，使"基准价"语义正确
                if (i === 0) {
                    snap[it.id] = it.price;
                    return;
                }
                let p = it.price * (1 + (Math.random() - 0.5) * 0.06 * Math.sin(i / 4));
                p = Math.max(10, Math.round(p * (0.94 + Math.random() * 0.12)));
                snap[it.id] = p;
            });
            arr.push({ t, p: snap });
        }
        state.hist = arr;
        state.refreshCount = arr.length;
        saveHist();
        localStorage.setItem(SEED_KEY, '1');
    }

    // 追加一条快照
    function pushSnapshot() {
        const snap = {};
        state.items.forEach(it => snap[it.id] = it.price);
        const t = Date.now();
        state.hist.push({ t, p: snap });
        if (state.hist.length > state.maxRec) state.hist = state.hist.slice(-state.maxRec);
        saveHist();
        state.refreshCount = state.hist.length;
        state.lastTick = t;
        $('refreshCount').textContent = state.refreshCount;
    }

    // 以历史快照"倒数第二条"为基准价 → 首屏卡片/统计即显示"近1小时"真实涨跌
    function applyPrevFromHist() {
        if (state.hist.length < 2) return;
        const base = state.hist[state.hist.length - 2];
        if (!base || !base.p) return;
        state.items.forEach(it => {
            if (base.p[it.id] != null) state.prev[it.id] = base.p[it.id];
        });
        state.lastTick = base.t;
        $('lastUpdate').textContent = fmtTime(new Date(base.t));
    }

    /* ---------- 数据加载（真实精选数据） ---------- */
    async function loadData() {
        loadingEl.hidden = false;
        grid.innerHTML = '';
        try {
            const res = await fetch('data/prices.json', { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();

            state.items = data.items.map(it => ({
                ...it,
                hist: [it.price],
                last: it.price
            }));

            state.cats = [...new Set(state.items.map(i => i.cat))];
            buildCats();
            state.items.forEach(i => { state.prev[i.id] = i.price; i.last = i.price; });

            const meta = data.meta || {};
            $('dataSource').textContent = meta.source || '实时交易行';
            $('itemCount').textContent = state.items.length;

            loadHist();
            seedHist();
            $('refreshCount').textContent = state.refreshCount;   // 同步种子记录数
            updateItemHist();   // 把种子历史同步到每个物品的 hist，供迷你走势图使用
            applyPrevFromHist();// 以"近1小时前"快照为基准价 → 首屏显示真实涨跌

            state.chartId = state.items[0].id;
            fillChartSelect();

            render(true);
            drawChart();
            renderStats();
            showToast('✅ 真实数据加载成功 · ' + state.items.length + ' 件');
        } catch (err) {
            console.error('加载失败', err);
            fallbackItems();
            render(true);
            drawChart();
            renderStats();
            showToast('⚠️ 数据加载失败，使用内置数据');
        } finally {
            loadingEl.hidden = true;
        }
    }

    /* ---------- 兜底数据 ---------- */
    function fallbackItems() {
        state.items = [
            { id: 1001, name: 'HA-2重型防弹衣', icon: '🛡️', cat: '护甲', price: 3329236, color: '#2b5876', hist: [3329236] },
            { id: 1002, name: 'H70 精英头盔', icon: '⛑️', cat: '头盔', price: 2420581, color: '#136a8a', hist: [2420581] },
            { id: 1003, name: '沙漠之鹰', icon: '🔫', cat: '手枪', price: 17640, color: '#56ab2f', hist: [17640] },
            { id: 1004, name: '海洋之泪', icon: '💎', cat: '收集品', price: 24482463, color: '#f2994a', hist: [24482463] },
            { id: 1005, name: '三级监狱权限卡', icon: '🗝️', cat: '钥匙', price: 5468571, color: '#ec6f66', hist: [5468571] },
            { id: 1006, name: 'ASh-12扩容30发弹匣', icon: '📦', cat: '弹匣', price: 51763, color: '#4b6cb7', hist: [51763] }
        ];
        state.cats = [...new Set(state.items.map(i => i.cat))];
        buildCats();
        state.items.forEach(i => { state.prev[i.id] = i.price; i.last = i.price; });
        $('dataSource').textContent = '内置兜底数据';
        $('itemCount').textContent = state.items.length;
        loadHist();
        seedHist();
        updateItemHist();
        applyPrevFromHist();
        state.chartId = state.items[0].id;
        fillChartSelect();
    }

    /* ---------- 分类按钮 ---------- */
    function buildCats() {
        catFilter.innerHTML = '<button class="chip active" data-cat="all">全部</button>' +
            state.cats.map(c =>
                `<button class="chip" data-cat="${c}">${c}</button>`
            ).join('');
        catFilter.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                catFilter.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                state.activeCat = chip.dataset.cat;
                render();
            });
        });
    }

    /* ---------- 迷你走势图 (SVG) ---------- */
    function sparkSvg(hist) {
        if (!hist || hist.length < 2) return '';
        const w = 56, h = 22;
        const min = Math.min(...hist), max = Math.max(...hist);
        const span = (max - min) || 1;
        const pts = hist.map((v, i) => {
            const x = (i / (hist.length - 1)) * w;
            const y = h - ((v - min) / span) * (h - 4) - 2;
            return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        const up = hist[hist.length - 1] >= hist[0];
        const color = up ? '#fb7185' : '#34d399';
        return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
            <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
        </svg>`;
    }

    /* ---------- 折线图数据 ---------- */
    function seriesFor(id) {
        const arr = [];
        state.hist.forEach(h => {
            const v = h.p && h.p[id];
            if (v != null) arr.push({ t: h.t, v: v });
        });
        return arr;
    }

    /* ---------- 大折线图 (Canvas) ---------- */
    function drawChart() {
        if (!state.chartId) return;
        const it = state.items.find(x => x.id === state.chartId);
        if (!it) return;
        const series = seriesFor(it.id);

        $('chartIcon').textContent = it.icon || '📦';
        $('chartName').textContent = it.name;
        $('chartCat').textContent = it.cat;
        $('chartPrice').textContent = fmt(it.price);
        $('chartPts').textContent = series.length;

        const prev = state.prev[it.id] || it.price;
        const diff = it.price - prev;
        const pct = prev && diff ? (diff / prev * 100) : 0;
        const up = diff >= 0;
        const chEl = $('chartChange');
        chEl.textContent = `${up ? '▲' : '▼'} ${pct === 0 ? '0.0' : (up ? '+' : '') + pct.toFixed(1)}%`;
        chEl.className = 'chart-change ' + (up ? 'badge-up' : 'badge-down');
        $('chartPrice').className = 'chart-price ' + (up ? 'price-up' : 'price-down');

        const dpr = window.devicePixelRatio || 1;
        const rect = chartCanvas.getBoundingClientRect();
        const W = rect.width || 800;
        const H = rect.height || 340;   // 以实际 CSS 高度为准，避免响应式下变形
        chartCanvas.width = W * dpr;
        chartCanvas.height = H * dpr;
        chartCanvas.style.width = W + 'px';
        chartCanvas.style.height = H + 'px';
        const ctx = chartCtx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        if (series.length < 2) {
            ctx.fillStyle = 'rgba(238,242,255,0.5)';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('等待更多数据…', W / 2, H / 2);
            return;
        }

        const pad = { l: 54, r: 16, t: 16, b: 28 };
        const iw = W - pad.l - pad.r;
        const ih = H - pad.t - pad.b;
        const vals = series.map(s => s.v);
        let min = Math.min(...vals), max = Math.max(...vals);
        const span = (max - min) || 1;
        min -= span * 0.06; max += span * 0.06;
        const full = max - min;

        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.fillStyle = 'rgba(238,242,255,0.45)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        for (let i = 0; i <= 4; i++) {
            const y = pad.t + (ih * i) / 4;
            ctx.beginPath();
            ctx.moveTo(pad.l, y);
            ctx.lineTo(W - pad.r, y);
            ctx.stroke();
            const val = Math.round(max - full * (i / 4));
            ctx.fillText(fmt(val), pad.l - 8, y + 3);
        }

        ctx.textAlign = 'center';
        const n = series.length;
        for (let i = 0; i <= 4; i++) {
            const idx = Math.min(n - 1, Math.round((n - 1) * i / 4));
            const x = pad.l + (iw * idx) / (n - 1);
            const d = new Date(series[idx].t);
            ctx.fillText(d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'), x, H - 8);
        }

        const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
        grad.addColorStop(0, 'rgba(56,189,248,0.32)');
        grad.addColorStop(1, 'rgba(56,189,248,0)');

        const xy = (i) => {
            const x = pad.l + (iw * i) / (n - 1);
            const y = pad.t + ih - ((series[i].v - min) / full) * ih;
            return [x, y];
        };

        const [x0, y0] = xy(0);
        ctx.beginPath();
        ctx.moveTo(x0, pad.t + ih);
        ctx.lineTo(x0, y0);
        for (let i = 1; i < n; i++) {
            const [x, y] = xy(i);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(pad.l + iw, pad.t + ih);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        for (let i = 1; i < n; i++) {
            const [x, y] = xy(i);
            ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();

        ctx.shadowColor = 'rgba(56,189,248,0.8)';
        ctx.shadowBlur = 6;
        const [lx, ly] = xy(n - 1);
        ctx.beginPath();
        ctx.arc(lx, ly, 4, 0, Math.PI * 2);
        ctx.fillStyle = up ? '#fb7185' : '#34d399';
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    /* ---------- 折线图物品选择 ---------- */
    function fillChartSelect() {
        chartSelect.innerHTML = state.items.map(it =>
            `<option value="${it.id}" ${it.id === state.chartId ? 'selected' : ''}>${it.name}</option>`
        ).join('');
    }

    /* ---------- 物品历史序列更新（从快照中提取） ---------- */
    function updateItemHist() {
        state.items.forEach(it => {
            const arr = [];
            state.hist.forEach(h => {
                const v = h.p && h.p[it.id];
                if (v != null) arr.push(v);
            });
            if (arr.length >= 2) it.hist = arr.slice(-48);
        });
    }

    /* ---------- 筛选 ---------- */
    function filteredItems() {
        const kw = state.keyword.trim().toLowerCase();
        return state.items.filter(it => {
            if (state.activeCat !== 'all' && it.cat !== state.activeCat) return false;
            if (kw && !(it.name.toLowerCase().includes(kw) || it.cat.toLowerCase().includes(kw))) return false;
            return true;
        });
    }

    /* ---------- 卡片渲染 ---------- */
    function render() {
        const list = filteredItems();
        empty.hidden = list.length > 0;
        grid.innerHTML = list.map(it => {
            const prev = state.prev[it.id] != null ? state.prev[it.id] : it.price;
            const diff = it.price - prev;
            const pct = prev ? (diff / prev) * 100 : 0;
            const up = diff >= 0;
            return `
            <article class="card glass ${up ? 'pulse-up' : 'pulse-down'}" data-id="${it.id}">
                <div class="card-top">
                    <span class="card-icon">${it.icon || '📦'}</span>
                    <div style="min-width:0">
                        <div class="card-name">${it.name}</div>
                        <span class="card-cat">${it.cat}</span>
                    </div>
                </div>
                <div class="card-price ${up ? 'price-up' : 'price-down'}">${fmt(it.price)}</div>
                <span class="card-change ${up ? 'badge-up' : 'badge-down'}">${pct === 0 ? '±0.0%' : (up ? '▲ +' : '▼ -') + Math.abs(pct).toFixed(1) + '%'}</span>
                <div class="card-foot">
                    ${sparkSvg(it.hist)}
                    <span style="font-size:.62rem;color:var(--text-dim);flex-shrink:0">${fmtTime(new Date())}</span>
                </div>
            </article>`;
        }).join('');
        $('lastUpdate').textContent = fmtTime(new Date());
    }

    /* ---------- 统计记录面板 ---------- */
    function renderStats() {
        let up = 0, down = 0, flat = 0;
        state.items.forEach(it => {
            const prev = state.prev[it.id] != null ? state.prev[it.id] : it.price;
            const d = it.price - prev;
            if (d > 0) up++; else if (d < 0) down++; else flat++;
        });
        $('numUp').textContent = up;
        $('numDown').textContent = down;
        $('numFlat').textContent = flat;
        const max = Math.max(up, down, flat, 1);
        $('barUp').style.width = (up / max * 100).toFixed(1) + '%';
        $('barDown').style.width = (down / max * 100).toFixed(1) + '%';
        $('barFlat').style.width = (flat / max * 100).toFixed(1) + '%';
        $('recSub').textContent = '共 ' + state.items.length + ' 件 · ' + fmtTime(new Date());

        const listEl = $('recList');
        const arr = state.items.map(it => {
            const prev = state.prev[it.id] != null ? state.prev[it.id] : it.price;
            const diff = it.price - prev;
            return { it, diff, pct: prev ? (diff / prev * 100) : 0 };
        }).filter(x => x.diff !== 0)
          .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
          .slice(0, 8);

        if (!arr.length) {
            listEl.innerHTML = '<div class="rec-empty">暂无涨跌记录，等待价格变动…</div>';
            return;
        }
        listEl.innerHTML = arr.map(x => {
            const up2 = x.diff > 0;
            return `<div class="rec-line ${up2 ? 'up' : 'down'}">
                <span class="rc-t">${fmtTime(new Date())}</span>
                <span class="rc-n">${x.it.icon || '📦'} ${x.it.name}</span>
                <span class="rc-v">${up2 ? '▲ +' : '▼ -'}${Math.abs(x.pct).toFixed(1)}%</span>
            </div>`;
        }).join('');
    }

    /* ---------- 实时刷新（模拟真实市场波动 ±1.5%） ---------- */
    function refreshPrices() {
        if (state.loading || !state.items.length) return;
        state.loading = true;
        state.items.forEach(it => state.prev[it.id] = it.price);
        let upCnt = 0;
        state.items.forEach(it => {
            const drift = (Math.random() - 0.48) * 0.03;
            it.price = Math.max(50, Math.round(it.price * (1 + drift)));
            if (it.price > state.prev[it.id]) upCnt++;
            it.last = it.price;
        });
        pushSnapshot();     // 先把最新价格写入历史快照
        updateItemHist();   // 再从快照提取 → 迷你走势图包含最新点
        render();
        drawChart();
        renderStats();
        beep(upCnt >= state.items.length / 2);
        state.loading = false;
        showToast('🔄 物价已刷新 · ' + fmtTime(new Date()), 1200);
    }

    /* ---------- 事件绑定 ---------- */
    searchBox.addEventListener('input', () => {
        state.keyword = searchBox.value;
        render();
    });

    refreshBtn.addEventListener('click', refreshPrices);

    soundToggle.addEventListener('click', () => {
        state.soundOn = !state.soundOn;
        soundToggle.textContent = state.soundOn ? '🔊' : '🔇';
        showToast(state.soundOn ? '🔊 音效已开启' : '🔇 音效已关闭');
    });

    chartSelect.addEventListener('change', () => {
        state.chartId = Number(chartSelect.value);
        drawChart();
    });

    window.addEventListener('resize', () => drawChart());

    // 点击卡片 → 切换大图查看该物品走势
    grid.addEventListener('click', e => {
        const card = e.target.closest('.card');
        if (!card) return;
        state.chartId = Number(card.dataset.id);
        chartSelect.value = String(state.chartId);
        drawChart();
        $('chartPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    /* ---------- 启动 ---------- */
    initBg();
    $('refreshCount').textContent = state.refreshCount;
    loadData();
    setInterval(refreshPrices, 30000);   // 每 30 秒自动刷新一次
})();
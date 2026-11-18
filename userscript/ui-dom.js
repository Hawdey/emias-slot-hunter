// userscript/ui-dom.js — видимый интерфейс: значок, мастер настройки из 4
// экранов. Единственный
// самозапускающийся модуль — все остальные части ядра только складывают
// себя в globalThis.EmiasCore, а этот файл их использует и рисует DOM.
//
// Простых людей без технической подготовки в тексте интерфейса не должно
// пугать ни одно слово — весь пользовательский текст на обычном русском.
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  // На всякий случай не даём смонтироваться дважды (например, если скрипт
  // случайно оказался подключён более одного раза).
  if (window.__emiasSlotHunterMounted) return;
  window.__emiasSlotHunterMounted = true;

  const { create, createUiState } = globalThis.EmiasCore;
  const ui = createUiState();
  const siteStorage = window.localStorage;
  const settings = new Map();
  const storage = {
    getItem: (key) => settings.get(key) ?? null,
    setItem: (key, value) => settings.set(key, value),
  };

  /* ==================== состояние мастера (переменная модуля) ==================== */
  // Ничего отсюда не пишется в хранилище раньше шага 3 — см. requirements.
  const wizard = {
    open: false,
    step: 0,
    options: [],        // результат discover()
    selected: [],        // выбранные варианты (option) с шага 1
    forms: {},           // option.id -> форма условий с шага 2
    report: null,         // результат dryRun() для текущих целей
    builtTargets: null,    // цели, переданные в core.setTargets перед прогоном
    checked: false,         // галочка «Я проверил(а)» на шаге 3
    loading: false,          // идёт discover()/dryRun()
    loadError: null,          // текст ошибки связи + что повторять
  };

  let core = null;
  let badgeState = { kind: 'init', text: '…', detail: '' };
  let panelMode = null; // 'wizard' | 'status' | 'recovery' | 'standby' | null
  const logEvents = [];
  const pendingConfirms = {}; // targetId -> { payload, expiresAt, tickId }
  // Узлы карточек «записать не удалось» (Task 12c minor): answerConfirm их
  // выводит УЖЕ после того, как отвязал карточку от pendingConfirms, и сама
  // держит на экране ещё RESULT_NOTE_MS — clearAllConfirmCards() их не
  // видит, если не следить за ними отдельно (см. ниже).
  const failedConfirmNodes = [];
  let statusRefreshId = null;
  let finishedAll = false; // все цели завершились сами — поиск остановлен
  let preBookedBadge = null; // значок до последнего «Записано», чтобы вернуть текст, а не только цвет
  let wizardLoading = false;
  let wizardGeneration = 0;
  // I-3: временное пояснение к зелёному значку (например, «записать не
  // удалось»), чтобы обновление раз в 5 секунд не стирало его сразу.
  let badgeNote = null; // { text, until }
  const foundCount = {}; // targetId -> сколько событий found пришло (чтобы не дублировать лог)

  const dom = {}; // ссылки на элементы внутри shadowRoot

  /* ==================== маленький помощник для сборки DOM ==================== */
  // Строим элементы без innerHTML — так текст из ответов ЕМИАС (адреса,
  // названия) никогда не интерпретируется как разметка.
  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'open') node[k] = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function hhmm(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ==================== таймер ядра: Web Worker из Blob ==================== */
  // Ровно два метода — schedule(ms, fn) и cancel() — как требует core/index.js.
  // Если Worker создать не удалось (например, страница это запрещает через
  // Content-Security-Policy), тихо переключаемся на обычный setTimeout.
  function createWorkerTimer() {
    let worker = null;
    let cb = null;
    let lastMs = 0;
    let scheduledAt = 0;
    let fallbackId = null;
    let usingFallback = false;

    function fallbackSchedule(ms, fn) {
      cb = fn;
      fallbackId = setTimeout(fn, ms);
    }

    // I9: Worker может упасть уже после успешного создания (CSP, старый
    // Safari) — тогда проверки молча останавливались бы навсегда при
    // зелёном значке. Переключаемся на setTimeout и перепланируем именно
    // тот вызов, который уже был отложен в воркере, на оставшееся время.
    function switchToFallback() {
      if (usingFallback) return;
      usingFallback = true;
      try { if (worker) worker.terminate(); } catch (e) { /* воркер уже недоступен */ }
      worker = null;
      if (cb) {
        const remaining = Math.max(0, lastMs - (Date.now() - scheduledAt));
        fallbackSchedule(remaining, cb);
      }
    }

    try {
      const code = "let t=null; onmessage=function(e){ clearTimeout(t); var ms=e.data&&e.data.ms; if(typeof ms==='number'&&ms>=0){ t=setTimeout(function(){ postMessage(1); }, ms);} };";
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
      // Minor: не оставляем blob-URL висеть — Worker уже получил код к этому
      // моменту, дальше URL не нужен.
      URL.revokeObjectURL(url);
      worker.onmessage = () => { if (cb) cb(); };
      worker.onerror = () => switchToFallback();
      return {
        schedule(ms, fn) {
          if (usingFallback) { fallbackSchedule(ms, fn); return; }
          cb = fn; lastMs = ms; scheduledAt = Date.now();
          worker.postMessage({ ms });
        },
        cancel() {
          cb = null;
          if (usingFallback) { if (fallbackId) clearTimeout(fallbackId); fallbackId = null; return; }
          if (worker) worker.postMessage({ ms: -1 });
        },
      };
    } catch (e) {
      return {
        schedule(ms, fn) { fallbackSchedule(ms, fn); },
        cancel() { if (fallbackId) clearTimeout(fallbackId); fallbackId = null; cb = null; },
      };
    }
  }

  /* ==================== звук и уведомление ==================== */
  function playBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch (e) { /* звук необязателен, тихо игнорируем */ }
  }

  // I8: раньше звук и уведомление были только у booked — у needConfirm их не
  // было, хотя на ответ всего 60 секунд, а вкладка обычно фоновая. Общая
  // функция используется для обоих случаев.
  // Minor: Notification.requestPermission() в старых Safari может не
  // вернуть промис вовсе — проверяем это и оборачиваем в try/catch с .catch,
  // чтобы такой браузер не ронял обработчик целиком.
  function notify(title, body) {
    playBeep();
    if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return;
    const show = () => {
      try { new Notification(title, { body }); } catch (e) { /* уведомление необязательно */ }
    };
    try {
      if (Notification.permission === 'granted') { show(); return; }
      if (Notification.permission === 'denied') return;
      // Старый callback-стиль и новый promise-стиль могут сработать оба —
      // handled не даёт показать уведомление дважды.
      let handled = false;
      const onResult = (perm) => { if (handled) return; handled = true; if (perm === 'granted') show(); };
      const p = Notification.requestPermission(onResult);
      if (p && typeof p.then === 'function') p.then(onResult).catch(() => { /* уведомление необязательно */ });
    } catch (e) { /* уведомление необязательно */ }
  }

  /* ==================== стили значка и мастера (только внутри shadowRoot) ==================== */
  function styles() {
    return `
      :host, * { box-sizing: border-box; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
      .esh-root { position: fixed; right: 16px; bottom: 16px; z-index: 999999; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
      .esh-badge { cursor: pointer; border: none; border-radius: 20px; padding: 10px 16px; font-size: 14px; color: #fff; background: #5b6472; box-shadow: 0 2px 8px rgba(0,0,0,.25); white-space: nowrap; }
      .esh-badge.k-idle, .esh-badge.k-init { background: #5b6472; }
      .esh-badge.k-running, .esh-badge.k-resuming { background: #2e9e5b; }
      .esh-badge.k-booked { background: #e08a2b; }
      .esh-badge.k-standby { background: #3a7bd5; }
      .esh-badge.k-paused { background: #8a6d3b; }
      .esh-badge.k-needLogin, .esh-badge.k-needIdentity, .esh-badge.k-sessionLost, .esh-badge.k-stale, .esh-badge.k-resumeError, .esh-badge.k-needDryRun { background: #d64545; }
      .esh-sub { display: block; font-size: 11px; opacity: .85; font-weight: normal; }
      .esh-card { width: 320px; max-width: calc(100vw - 32px); box-sizing: border-box; max-height: 70vh; overflow: auto; background: #fff; color: #222; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.3); padding: 14px; }
      .esh-card h3 { margin: 0 0 8px; font-size: 16px; }
      .esh-card p { margin: 4px 0; font-size: 13px; line-height: 1.4; }
      .esh-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
      .esh-opt { border: 1px solid #e0e0e0; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
      .esh-opt.disabled { opacity: .55; }
      .esh-opt .title { font-weight: 600; font-size: 13px; }
      .esh-opt .meta { font-size: 12px; color: #666; }
      .esh-opt .reason { font-size: 12px; color: #a33; }
      .esh-field { display: block; font-size: 12px; margin: 6px 0 2px; color: #444; }
      .esh-card input[type=text], .esh-card input[type=date], .esh-card input[type=time] { width: 100%; padding: 4px 6px; margin-top: 4px; font-size: 13px; border: 1px solid #ccc; border-radius: 6px; }
      .esh-btns { display: flex; gap: 8px; margin-top: 12px; }
      .esh-btn { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc; background: #f4f4f4; cursor: pointer; font-size: 13px; }
      .esh-btn.primary { background: #2e7dd7; color: #fff; border-color: #2e7dd7; }
      .esh-btn.primary:disabled { background: #a9c6ea; border-color: #a9c6ea; cursor: not-allowed; }
      .esh-btn.danger { background: #d64545; color: #fff; border-color: #d64545; }
      .esh-warn { color: #a33; font-size: 12px; }
      .esh-note { color: #666; font-size: 12px; }
      .esh-status-target { margin-bottom: 8px; }
      .esh-status-target p { margin: 2px 0; }
      .esh-confirm { width: 300px; max-width: calc(100vw - 32px); box-sizing: border-box; background: #fff8ea; border: 1px solid #e0b84b; border-radius: 10px; padding: 10px; margin-bottom: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.2); }
      .esh-slept { width: 300px; background: #eef2ff; border: 1px solid #98a6e0; border-radius: 10px; padding: 10px; display: flex; justify-content: space-between; gap: 8px; }
      /* .esh-slept задаёт свой display: flex — этим он перебивает display:
         none из стандартного правила [hidden] (авторское правило с любым
         указанным display выигрывает у правила User Agent), и пустая рамка
         остаётся видна поверх значка, пока карточку не заполнили текстом.
         Возвращаем скрытие явно. */
      .esh-slept[hidden] { display: none; }
      .esh-log { font-size: 12px; max-height: 160px; overflow: auto; background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 6px; }
      .esh-log div { margin-bottom: 4px; }
      details.esh-more summary { cursor: pointer; font-size: 12px; color: #2e7dd7; margin-top: 6px; }
    `;
  }

  /* ==================== создание корневого элемента (один раз) ==================== */
  function mountBadge() {
    const host = document.createElement('div');
    host.id = 'emias-slot-hunter-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(h('style', { text: styles() }));

    const root = h('div', { class: 'esh-root' });
    const badge = h('button', { class: 'esh-badge k-init', onclick: onBadgeClick, text: 'ЕМИАС: охотник за слотами' });
    const confirms = h('div', { class: 'esh-confirms' });
    const slept = h('div', { class: 'esh-slept', hidden: true });
    const panel = h('div', { class: 'esh-card', hidden: true });

    root.appendChild(confirms);
    root.appendChild(slept);
    root.appendChild(panel);
    root.appendChild(badge);
    shadow.appendChild(root);
    document.body.appendChild(host);

    Object.assign(dom, { shadow, root, badge, confirms, slept, panel });
  }

  /* ==================== значок ==================== */
  function setBadge(next) {
    badgeState = { ...badgeState, ...next };
    renderBadge(badgeState);
  }

  function renderBadge(status) {
    const b = dom.badge;
    b.className = 'esh-badge k-' + status.kind;
    clear(b);
    b.appendChild(document.createTextNode(status.text));
    if (status.detail) b.appendChild(h('span', { class: 'esh-sub', text: status.detail }));
  }

  function onBadgeClick() {
    if (panelMode) { hidePanel(); return; }
    const kind = badgeState.kind;
    if (kind === 'booked') { acknowledgeBooked(); openStatusPanel(); return; }
    if (kind === 'running' || kind === 'stale' || kind === 'finished') { openStatusPanel(); return; }
    if (kind === 'standby') { openStandbyPanel(); return; }
    prepareWizard();
  }

  async function prepareWizard() {
    if (wizardLoading) return;
    resetSearch();
    wizardLoading = true;
    const generation = ++wizardGeneration;
    try {
      await core.init();
      if (generation === wizardGeneration) openWizard(1);
    } catch (e) {
      if (generation === wizardGeneration) setBadge(initErrorBadge(e));
    } finally {
      wizardLoading = false;
    }
  }

  function showPanel() { dom.panel.hidden = false; }
  function hidePanel() { dom.panel.hidden = true; panelMode = null; wizard.open = false; }

  function openStandbyPanel() {
    panelMode = 'standby';
    showPanel();
    clear(dom.panel);
    dom.panel.appendChild(h('p', { text: 'Поиск идёт в другой вкладке. Остановите его там перед запуском здесь.' }));
    dom.panel.appendChild(h('button', { class: 'esh-btn', text: 'Настроить заново', onclick: () => { hidePanel(); prepareWizard(); } }));
  }

  /* ==================== лог событий (для статус-панели) ==================== */
  function pushLog(entry) {
    logEvents.unshift(entry);
    if (logEvents.length > 40) logEvents.length = 40;
    if (panelMode === 'status') renderStatusPanel();
  }

  function renderLog(events) {
    const box = h('div', { class: 'esh-log' });
    for (const e of events.slice(0, 20)) box.appendChild(h('div', { text: `${hhmm(e.at)} · ${e.msg}` }));
    if (!events.length) box.appendChild(h('div', { class: 'esh-note', text: 'событий пока нет' }));
    return box;
  }

  function titleFor(targetId) {
    const t = (core.status().targets || []).find((x) => x.id === targetId);
    return (t && t.title) || 'Запись';
  }

  /* ==================== статус-панель (что происходит сейчас) ==================== */
  function renderStatusPanel() {
    const st = core.status();
    const waiting = new Set(st.pending);
    // Под каждой целью — условия поиска теми же словами, что на шаге 3 мастера.
    // Берём сохранённые цели: в них current уже обновлён после переноса.
    const cfg = ui.loadConfig(storage);
    const saved = new Map(((cfg && cfg.targets) || []).map((x) => [x.id, x]));
    const lines = st.targets.map((t) => {
      const conditions = saved.has(t.id) ? describeConditions(saved.get(t.id)) : '';
      return h('div', { class: 'esh-status-target' }, [
        h('p', { text: `${t.title}: ${waiting.has(t.id) ? 'жду вашего решения' : describeState(t)}` }),
        conditions ? h('p', { class: 'esh-note', text: 'Условия: ' + conditions }) : null,
      ]);
    });
    // Панель перерисовывается целиком каждые 5 секунд (см. startStatusRefresh)
    // и на каждое новое событие лога — без этого позиция прокрутки в логе
    // сбрасывалась бы к началу при каждой перерисовке.
    const prevLog = dom.panel.querySelector('.esh-log');
    const logScrollTop = prevLog ? prevLog.scrollTop : 0;
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Что сейчас происходит' }));
    // M-1: время берём из lastCheckAt — его ставит только настоящая проверка.
    dom.panel.appendChild(h('p', { class: 'esh-note', text: `Последняя проверка: ${st.lastCheckAt ? hhmm(st.lastCheckAt) : 'ещё не было'}` }));
    dom.panel.appendChild(h('div', {}, lines));
    const logBox = renderLog(logEvents);
    dom.panel.appendChild(logBox);
    logBox.scrollTop = logScrollTop;
    const stopBtn = st.running
      ? h('button', { class: 'esh-btn danger', text: 'Остановить поиск', onclick: onStop })
      : h('button', { class: 'esh-btn primary', text: 'Настроить заново', onclick: () => { hidePanel(); prepareWizard(); } });
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [stopBtn]));
  }

  function describeState(t) {
    if (t.state === 'stopped') return `остановлено (${t.note || 'причина неизвестна'})`;
    if (t.state === 'done') return 'готово';
    if (t.state === 'improving') return 'записано, ищу вариант получше';
    return 'проверяю расписание';
  }

  // describeTarget начинает с «<название>: …» — название уже есть строкой выше.
  function describeConditions(target) {
    const text = ui.describeTarget(target);
    const prefix = target.title + ': ';
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  }

  function openStatusPanel() { panelMode = 'status'; showPanel(); renderStatusPanel(); }

  /* ==================== мастер: открытие и переключение шагов ==================== */
  function openWizard(step) {
    panelMode = 'wizard';
    wizard.open = true;
    wizard.step = step;
    showPanel();
    if (step === 1) loadStep1();
    else if (step === 2) renderStep2(wizard.selected);
    else if (step === 3) loadStep3();
    else if (step === 4) renderStep4();
  }

  function renderLoading(title) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: title }));
    dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Спрашиваю ЕМИАС, подождите…' }));
  }

  function renderLoadError(title, message, onRetry) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: title }));
    dom.panel.appendChild(h('p', { class: 'esh-warn', text: message }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn primary', text: 'Повторить', onclick: onRetry }),
    ]));
  }

  /* ==================== шаг 1: выбор направлений и записей ==================== */
  async function loadStep1() {
    const generation = wizardGeneration;
    renderLoading('Шаг 1 из 3. За чем следить');
    try {
      const options = await core.discover();
      if (generation !== wizardGeneration || !wizard.open || wizard.step !== 1) return;
      wizard.options = options;
      renderStep1(options);
    } catch (e) {
      if (generation !== wizardGeneration || !wizard.open || wizard.step !== 1) return;
      if (e.name === 'SessionError') { onSessionLost(e); return; }
      renderLoadError('Шаг 1 из 3. За чем следить', e && e.message, loadStep1);
    }
  }

  function isSelected(option) { return wizard.selected.some((o) => o.id === option.id); }

  function toggleOption(option, on) {
    wizard.selected = wizard.selected.filter((o) => o.id !== option.id);
    if (on) wizard.selected.push(option);
    // Кнопка «Далее» рисуется один раз вместе со списком — без этого она
    // оставалась неактивной, пока мастер не перерисуют заново.
    if (dom.step1Next) dom.step1Next.disabled = wizard.selected.length === 0;
  }

  function renderOptionRow(option) {
    const supported = option.supported !== false;
    const box = h('div', { class: 'esh-opt' + (supported ? '' : ' disabled') });
    const checkbox = h('input', {
      type: 'checkbox', checked: isSelected(option), disabled: !supported,
      onchange: (e) => toggleOption(option, e.target.checked),
    });
    box.appendChild(h('label', { class: 'esh-row' }, [
      checkbox,
      h('div', {}, [
        h('div', { class: 'title', text: option.title }),
        h('div', { class: 'meta', text: describeOptionMeta(option) }),
        !supported ? h('div', { class: 'reason', text: option.unsupportedReason || 'пока не поддерживается' }) : null,
      ]),
    ]));
    return box;
  }

  function describeOptionMeta(option) {
    const parts = [];
    if (option.source?.doctorName) parts.push(option.source.doctorName);
    if (option.current) parts.push('сейчас записано на ' + ui.human(option.current));
    if (option.address) parts.push(ui.stripCampus(option.address));
    if (option.deadline) parts.push('направление действует по ' + option.deadline.slice(8, 10) + '.' + option.deadline.slice(5, 7));
    return parts.join(' · ') || 'запись по направлению';
  }

  function renderStep1(options) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Шаг 1 из 3. За чем следить' }));
    if (!options.length) {
      dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Направлений и записей, с которыми можно работать, не найдено.' }));
    }
    const list = h('div', {}, options.map(renderOptionRow));
    dom.panel.appendChild(list);
    const next = h('button', {
      class: 'esh-btn primary', text: 'Далее', disabled: wizard.selected.length === 0,
      onclick: () => openWizard(2),
    });
    dom.step1Next = next;
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [next]));
  }

  /* ==================== шаг 2: условия для каждого выбранного пункта ==================== */
  function ensureForm(option) {
    if (!wizard.forms[option.id]) {
      wizard.forms[option.id] = {
        // Для новой записи 'earlier' показывается как «как можно раньше».
        when: 'earlier',
        day: '', dateFrom: '', dateTo: '', timeFrom: '', timeTo: '',
        where: option.address ? 'sameCampus' : 'any', addressContains: '',
        respectTravel: true, mode: 'confirm', purpose: 'unwell', keepImproving: false, sameDoctor: false,
      };
    }
    return wizard.forms[option.id];
  }

  function doctorField(option, form, update) {
    if (option.scenario !== 'shiftDoctor') return null;
    const field = h('div', {}, [h('label', { class: 'esh-row' }, [
      h('input', { type: 'checkbox', checked: form.sameDoctor, onchange: (event) => update({ sameDoctor: event.target.checked }) }),
      h('span', { text: 'Только тот же врач' }),
    ])]);
    if (!form.sameDoctor) return field;
    const originalName = option.source.doctorName;
    if (option.source.availableResourceId) {
      if (originalName) field.appendChild(h('p', { class: 'esh-note', text: originalName }));
      return field;
    }
    const text = originalName ? `Текущий врач: ${originalName}. Выберите его в списке.` : 'Сверьте имя врача в текущей записи ЕМИАС и выберите его в списке.';
    field.appendChild(h('p', { text }));
    if (form.doctors) {
      const items = form.doctors.map((doctor) => h('option', {
        value: String(doctor.id), text: doctor.ambiguous ? `${doctor.name} (есть совпадения имени)` : doctor.name,
        disabled: doctor.ambiguous, selected: form.doctor?.id === doctor.id,
      }));
      const placeholder = h('option', { value: '', text: 'Выберите врача', selected: !form.doctor });
      if (items.length) {
        field.appendChild(h('select', {
          'aria-label': 'Врач для переноса',
          onchange: (event) => update({ doctor: form.doctors.find((doctor) => !doctor.ambiguous && String(doctor.id) === event.target.value) }),
        }, [placeholder, ...items]));
      } else {
        field.appendChild(h('p', { class: 'esh-note', text: 'ЕМИАС пока не предлагает врачей для переноса этой записи.' }));
      }
    }
    if (form.doctorListError) field.appendChild(h('p', { class: 'esh-warn', text: form.doctorListError }));
    if (!form.doctors?.some((doctor) => !doctor.ambiguous)) field.appendChild(h('button', {
      class: 'esh-btn', disabled: !!form.loadingDoctors,
      text: form.loadingDoctors ? 'Загружаю список…' : 'Показать список врачей',
      onclick: () => loadDoctors(option, form, update),
    }));
    return field;
  }

  async function loadDoctors(option, form, update) {
    if (form.loadingDoctors) return;
    const generation = wizardGeneration;
    update({ loadingDoctors: true, doctorListError: '' });
    const visible = () => generation === wizardGeneration && wizard.open && wizard.step === 2;
    try {
      const doctors = await core.listDoctors(option);
      if (visible()) update({ doctors, loadingDoctors: false });
    } catch (error) {
      if (!visible()) return;
      if (error.name === 'SessionError') { onSessionLost(error); return; }
      update({ loadingDoctors: false, doctorListError: error.message });
    } finally {
      form.loadingDoctors = false;
    }
  }

  // Направление к врачу с needPurpose: true — сайт требует выбрать цель визита
  // (см. capture-2026-09-24-referral-doctor.md), иначе расписание и запись
  // отклоняются. Для остальных целей поле form.purpose ни на что не влияет.
  function purposeField(option, form, update) {
    if (!(option.source && option.source.needPurpose)) return null;
    const opts = [
      ['unwell', ui.INQUIRY_PURPOSES.unwell.title],
      ['documents', ui.INQUIRY_PURPOSES.documents.title],
    ];
    const group = h('div', {}, opts.map(([val, text]) => h('label', { class: 'esh-row' }, [
      h('input', { type: 'radio', name: 'purpose-' + option.id, checked: (form.purpose || 'unwell') === val, onchange: () => update({ purpose: val }) }),
      h('span', { text }),
    ])));
    return h('div', {}, [h('label', { class: 'esh-field', text: 'Цель визита' }), group]);
  }

  function whenField(option, form, update, quiet) {
    const opts = [
      ['earlier', option.current ? 'раньше, чем сейчас записано' : 'как можно раньше'],
      ...(option.current ? [['sameDayEarlier', 'в тот же день, но раньше']] : []),
      ['onlyDay', 'в выбранный день, в любое время'],
    ];
    const group = h('div', {}, opts.map(([val, text]) => h('label', { class: 'esh-row' }, [
      h('input', { type: 'radio', name: 'when-' + option.id, checked: form.when === val, onchange: () => update({ when: val }) }),
      h('span', { text }),
    ])));
    const dayInput = form.when === 'onlyDay' ? h('input', {
      type: 'date', value: form.day, onchange: (e) => quiet({ day: e.target.value }),
    }) : null;
    return h('div', {}, [group, dayInput]);
  }

  function whereField(option, form, update, quiet) {
    const opts = [
      ...(option.address ? [['sameCampus', 'по этому же адресу (любой корпус)']] : []),
      ['any', 'где угодно'],
      ['contains', 'адрес содержит:'],
    ];
    const group = h('div', {}, opts.map(([val, text]) => h('label', { class: 'esh-row' }, [
      h('input', { type: 'radio', name: 'where-' + option.id, checked: form.where === val, onchange: () => update({ where: val }) }),
      h('span', { text }),
    ])));
    const addrInput = form.where === 'contains' ? h('input', {
      type: 'text', value: form.addressContains, placeholder: 'например, Ленина',
      oninput: (e) => quiet({ addressContains: e.target.value }),
    }) : null;
    return h('div', {}, [group, addrInput]);
  }

  function advancedFields(form, quiet) {
    const field = (label, type, key) => h('label', { class: 'esh-field' }, [
      label, h('input', { type, value: form[key], onchange: (e) => quiet({ [key]: e.target.value }) }),
    ]);
    // Раскрыт ли блок, помним в форме: шаг перерисовывается при выборе любого
    // переключателя, и без этого блок каждый раз схлопывался заново.
    return h('details', { class: 'esh-more', open: !!form.moreOpen, ontoggle: (e) => { form.moreOpen = e.target.open; } }, [
      h('summary', { text: 'Дополнительно: даты и время' }),
      field('Не раньше какого дня', 'date', 'dateFrom'),
      field('Не позже какого дня', 'date', 'dateTo'),
      field('Время не раньше', 'time', 'timeFrom'),
      field('Время не позже', 'time', 'timeTo'),
    ]);
  }

  function renderTargetCard(option) {
    const form = ensureForm(option);
    const update = (patch) => { Object.assign(form, patch); renderStep2(wizard.selected); };
    // Поля ввода (даты, время, адрес) меняют форму без перерисовки шага.
    // Браузер шлёт change у поля даты уже на первой цифре года («0002»), и
    // перерисовка подставляла этот год в новое поле и уводила курсор, так что
    // год с клавиатуры было не набрать. Обновляем только ошибку и «Далее».
    const quiet = (patch) => { Object.assign(form, patch); refreshStepTwoState(); };
    const card = h('div', { class: 'esh-opt' });
    card.appendChild(h('div', { class: 'title', text: option.title }));
    const doctor = doctorField(option, form, update);
    if (doctor) card.appendChild(doctor);
    card.appendChild(h('label', { class: 'esh-field', text: 'Когда' }));
    card.appendChild(whenField(option, form, update, quiet));
    card.appendChild(h('label', { class: 'esh-field', text: 'Где' }));
    card.appendChild(whereField(option, form, update, quiet));
    const purpose = purposeField(option, form, update);
    if (purpose) card.appendChild(purpose);
    card.appendChild(h('label', { class: 'esh-row' }, [
      h('input', { type: 'checkbox', checked: form.respectTravel, onchange: (e) => update({ respectTravel: e.target.checked }) }),
      h('span', { text: 'Учитывать время на дорогу между записями' }),
    ]));
    card.appendChild(h('label', { class: 'esh-field', text: 'Как записывать' }));
    card.appendChild(h('div', {}, [
      h('label', { class: 'esh-row' }, [
        h('input', { type: 'radio', name: 'mode-' + option.id, checked: form.mode === 'auto', onchange: () => update({ mode: 'auto' }) }),
        h('span', { text: 'сразу, без вопросов' }),
      ]),
      h('label', { class: 'esh-row' }, [
        h('input', { type: 'radio', name: 'mode-' + option.id, checked: form.mode === 'confirm', onchange: () => update({ mode: 'confirm' }) }),
        h('span', { text: 'сначала спрашивать' }),
      ]),
    ]));
    if (form.when !== 'onlyDay') {
      card.appendChild(h('label', { class: 'esh-row' }, [
        h('input', { type: 'checkbox', checked: form.keepImproving, onchange: (e) => update({ keepImproving: e.target.checked }) }),
        h('span', { text: 'Продолжать искать более ранний слот после успеха' }),
      ]));
    }
    card.appendChild(advancedFields(form, quiet));
    const error = stepTwoError(option, form);
    const errorEl = h('p', { class: 'esh-warn', text: error || '', hidden: !error });
    errorEl.dataset.optionId = option.id;
    card.appendChild(errorEl);
    return card;
  }

  function stepTwoError(option, form) {
    if (option.scenario === 'shiftDoctor' && form.sameDoctor && !option.source.availableResourceId && !form.doctor) return 'выберите врача для переноса';
    if (form.when === 'onlyDay' && !form.day) return 'выберите день';
    if (form.where === 'contains' && !form.addressContains.trim()) return 'укажите часть адреса';
    if (form.dateFrom && form.dateTo && form.dateFrom > form.dateTo) return 'проверьте порядок дат';
    if (form.timeFrom && form.timeTo && form.timeFrom > form.timeTo) return 'проверьте порядок времени';
    return null;
  }

  // «Назад» на шаге 1: варианты уже получены discover()-ом при первом входе
  // на шаг 1 в этом сеансе мастера — рисуем из wizard.options, не ходим в
  // сеть повторно.
  function backToStep1() {
    panelMode = 'wizard';
    wizard.open = true;
    wizard.step = 1;
    showPanel();
    renderStep1(wizard.options);
  }

  function renderStep2(selected) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Шаг 2 из 3. Условия поиска' }));
    dom.panel.appendChild(h('div', {}, selected.map(renderTargetCard)));
    const hasErrors = selected.some((o) => stepTwoError(o, ensureForm(o)));
    const back = h('button', { class: 'esh-btn', text: 'Назад', onclick: backToStep1 });
    const next = h('button', { class: 'esh-btn primary', text: 'Далее', disabled: hasErrors, onclick: () => openWizard(3) });
    next.dataset.role = 'step2-next';
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [back, next]));
  }

  // Обновляет ошибки карточек и кнопку «Далее» на шаге 2 без перерисовки.
  function refreshStepTwoState() {
    let hasErrors = false;
    for (const o of wizard.selected) {
      const error = stepTwoError(o, ensureForm(o));
      if (error) hasErrors = true;
      const el = [...dom.panel.querySelectorAll('p.esh-warn')].find((p) => p.dataset.optionId === String(o.id));
      if (el) { el.textContent = error || ''; el.hidden = !error; }
    }
    const next = dom.panel.querySelector('[data-role="step2-next"]');
    if (next) next.disabled = hasErrors;
  }

  /* ==================== шаг 3: холостой прогон и запуск ==================== */
  async function loadStep3() {
    const generation = wizardGeneration;
    renderLoading('Шаг 3 из 3. Проверка перед запуском');
    wizard.builtTargets = wizard.selected.map((o) => ui.buildTarget(o, ensureForm(o)));
    core.setTargets(wizard.builtTargets);
    try {
      const report = await core.dryRun();
      if (generation !== wizardGeneration || !wizard.open || wizard.step !== 3) return;
      wizard.report = report;
      wizard.checked = false;
      renderStep3(wizard.report);
    } catch (e) {
      if (generation !== wizardGeneration || !wizard.open || wizard.step !== 3) return;
      if (e.name === 'SessionError') { onSessionLost(e); return; }
      renderLoadError('Шаг 3 из 3. Проверка перед запуском', e && e.message, loadStep3);
    }
  }

  function renderReportItem(item) {
    const text = ui.describeDryRunItem(item);
    const [head, ...rest] = text.split('\n');
    const box = h('div', { class: 'esh-opt' });
    box.appendChild(h('p', { text: head }));
    for (const line of rest) {
      const warn = line.trim().startsWith('⚠');
      box.appendChild(h('p', { class: warn ? 'esh-warn' : 'esh-note', text: line.trim() }));
    }
    return box;
  }

  function renderStep3(report) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Шаг 3 из 3. Проверка перед запуском' }));
    dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Это холостой прогон: скрипт проверил расписание и показывает, что сделал бы прямо сейчас. Ничего не записано и не перенесено.' }));
    dom.panel.appendChild(h('div', {}, (wizard.builtTargets || []).map((t) => h('p', { text: ui.describeTarget(t) }))));
    dom.panel.appendChild(h('div', {}, report.items.map(renderReportItem)));
    const checkbox = h('input', {
      type: 'checkbox', checked: wizard.checked,
      onchange: (e) => { wizard.checked = e.target.checked; renderStep3(wizard.report); },
    });
    dom.panel.appendChild(h('label', { class: 'esh-row' }, [checkbox, h('span', { text: 'Я проверил(а) результаты холостого прогона' })]));
    const btns = [];
    if (wizard.selected.length) btns.push(h('button', { class: 'esh-btn', text: 'Назад', onclick: () => openWizard(2) }));
    btns.push(h('button', { class: 'esh-btn primary', text: 'Запустить охоту', disabled: !wizard.checked, onclick: onStart }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, btns));
  }

  /* ==================== шаг 4: подтверждение запуска ==================== */
  function renderStep4() {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Готово' }));
    dom.panel.appendChild(h('p', {}, 'Слежу за расписанием. Значок будет зелёным, пока идёт поиск.'));
    const titles = (wizard.builtTargets || []).map((t) => t.title).join(', ');
    if (titles) dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Слежу за: ' + titles }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn primary', text: 'Понятно', onclick: hidePanel }),
    ]));
  }

  async function onStart(event) {
    if (!event.isTrusted) return;
    event.currentTarget.disabled = true;
    // C1: защита от запуска по пустому списку целей (например, если сюда
    // всё же попали с испорченным состоянием мастера) — без неё в настройки
    // тихо сохранился бы targets: [] при зелёном значке.
    if (!wizard.builtTargets || !wizard.builtTargets.length) {
      renderLoadError('Шаг 3 из 3. Проверка перед запуском', 'Список целей пуст — нечего запускать. Начните заново с шага 1.', prepareWizard);
      return;
    }
    try {
      core.checkSession();
      core.confirmDryRun(wizard.report.id);
      await core.start();
      ui.saveConfig(storage, { targets: wizard.builtTargets });
      // Minor: сразу после старта проверок ещё не было — не выдумываем время
      // последней проверки.
      setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: 'ожидаю первую проверку' });
      startStatusRefresh();
      openWizard(4);
    } catch (e) {
      if (e.name === 'SessionError') { onSessionLost(e); return; }
      renderLoadError('Шаг 3 из 3. Проверка перед запуском', e && e.message, () => renderStep3(wizard.report));
    }
  }

  function resetSearch(finishInFlight = false) {
    wizardGeneration++;
    core.clearSession(finishInFlight);
    stopStatusRefresh();
    clearAllConfirmCards();
    settings.clear();
    logEvents.length = 0;
    preBookedBadge = null;
    finishedAll = false;
    Object.assign(wizard, { options: [], selected: [], forms: {}, report: null, builtTargets: null, checked: false });
    hidePanel();
  }

  function onStop() {
    const booking = core.status().booking;
    resetSearch(true);
    setBadge({
      kind: 'idle', text: '🎯 Настроить',
      detail: booking ? 'Проверьте, успел ли измениться приём в ЕМИАС.' : 'Поиск остановлен',
    });
  }

  /* ==================== запросы на подтверждение слота (mode: confirm) ==================== */
  function renderConfirmCard(targetId) {
    const p = pendingConfirms[targetId];
    if (!p) return;
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
    const card = h('div', { class: 'esh-confirm' });
    // I7: должно быть видно, что именно отдаётся — для переноса называем и
    // текущее время записи, и найденное, а не только найденное.
    const t = (core.status().targets || []).find((x) => x.id === targetId);
    const current = t && t.current;
    const headText = current
      ? `${p.payload.title}: перенесу с ${ui.human(current)} на ${ui.human(p.payload.slot.startTime)}`
      : `${p.payload.title}: запишу на ${ui.human(p.payload.slot.startTime)}`;
    card.appendChild(h('p', { text: headText }));
    if (p.payload.doctorName) card.appendChild(h('p', { text: p.payload.doctorName }));
    if (p.payload.address) card.appendChild(h('p', { class: 'esh-note', text: p.payload.address }));
    card.appendChild(h('p', { class: 'esh-note', text: `Осталось ${left} с` }));
    card.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn', text: 'Пропустить', onclick: (e) => { if (e.isTrusted) answerConfirm(targetId, p.payload.offerId, 'skip'); } }),
      h('button', { class: 'esh-btn primary', text: 'Записать', onclick: (e) => { if (e.isTrusted) answerConfirm(targetId, p.payload.offerId, 'book'); } }),
    ]));
    if (p.node) dom.confirms.replaceChild(card, p.node);
    else dom.confirms.appendChild(card);
    p.node = card;
  }

  // I6: карточки режима «спросить» надо чистить и при остановке, и при
  // standby — иначе остаётся живой отсчёт и кнопки, которые уже ничего не
  // делают (answer() на остановленном раннере просто отклонится).
  function clearAllConfirmCards() {
    for (const targetId of Object.keys(pendingConfirms)) removeConfirmCard(targetId);
    // Task 12c minor: карточка «записать не удалось» уже не в
    // pendingConfirms (answerConfirm удаляет её оттуда сразу после ответа),
    // но сам узел ещё несколько секунд на экране — без этого списка она
    // пережила бы остановку/standby и провисела бы впустую до RESULT_NOTE_MS.
    for (const entry of failedConfirmNodes.splice(0)) {
      clearTimeout(entry.timeoutId);
      if (entry.node && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
    }
  }

  function onNeedConfirm(payload) {
    // I8: окно ответа всего 60 секунд, а вкладка обычно фоновая — без звука
    // и уведомления человек может просто не заметить запрос вовремя.
    notify('ЕМИАС: найден слот', 'Откройте вкладку ЕМИАС. На решение есть 60 секунд.');
    const targetId = payload.targetId;
    removeConfirmCard(targetId);
    const tickId = setInterval(() => {
      const p = pendingConfirms[targetId];
      if (!p || Date.now() >= p.expiresAt) { removeConfirmCard(targetId); return; }
      renderConfirmCard(targetId);
    }, 1000);
    pendingConfirms[targetId] = { payload, expiresAt: payload.expiresAt, tickId, node: null };
    renderConfirmCard(targetId);
  }

  function removeConfirmCard(targetId) {
    const p = pendingConfirms[targetId];
    if (!p) return;
    clearInterval(p.tickId);
    if (p.node && p.node.parentNode) p.node.parentNode.removeChild(p.node);
    delete pendingConfirms[targetId];
  }

  // I5/I-3: результат core.answer() показываем человеку на месте карточки:
  // пока ждём ответа — «Записываю…», при неудаче — понятный итог на
  // несколько секунд и то же в пояснении к значку. Дубля в логе избегаем
  // сравнением foundCount до/после core.answer(), а не перечислением
  // исходов: в большинстве неудач runner.js:finish() сам шлёт found с тем
  // же текстом, и onFound уже его залогировал, — но не всегда (например,
  // при res.action === 'relogin' finish() шлёт sessionLost, а не found, и
  // foundCount не растёт). Счётчик учитывает это сам: alreadyLogged
  // окажется false, и текст залогируется здесь, в answerConfirm, — без
  // догадок о том, какие именно исходы finish() уже успел залогировать.
  const RESULT_NOTE_MS = 7000;

  function showCardNote(node, text, warn) {
    clear(node);
    node.appendChild(h('p', { class: warn ? 'esh-warn' : 'esh-note', text }));
  }

  async function answerConfirm(targetId, offerId, decision) {
    const p = pendingConfirms[targetId];
    if (!p || p.busy || p.payload.offerId !== offerId) return;
    const title = titleFor(targetId);
    const bookDecision = decision === 'book';
    const node = p && p.node;
    // Сохраняем карточку в списке, чтобы остановка могла убрать её сразу.
    clearInterval(p.tickId);
    p.busy = true;
    const dropNode = () => { if (node && node.parentNode) node.parentNode.removeChild(node); };
    if (!bookDecision) {
      removeConfirmCard(targetId);
      try { await core.answer(targetId, 'skip', offerId); } catch (e) { /* пропуск ничего не отправляет */ }
      return;
    }
    if (node) showCardNote(node, `${title}: записываю…`, false);
    const foundBefore = foundCount[targetId] || 0;
    let failText = null;
    let alreadyLogged = false;
    let cancelled = false;
    try {
      const res = await core.answer(targetId, 'book', offerId);
      cancelled = !!res?.aborted;
      if (!cancelled && (!res || !res.ok || !res.verified)) {
        failText = (res && res.message) || 'слот уже не актуален';
        alreadyLogged = (foundCount[targetId] || 0) > foundBefore;
      }
    } catch (e) {
      failText = (e && e.message) || 'неизвестная ошибка';
    }
    if (pendingConfirms[targetId] !== p) return;
    delete pendingConfirms[targetId];
    if (cancelled || !failText) { dropNode(); return; }
    if (!node?.isConnected || badgeState.kind === 'needLogin') { dropNode(); return; }
    const text = `${title}: ${failText}`;
    if (!alreadyLogged) pushLog({ at: Date.now(), msg: text });
    if (node) {
      showCardNote(node, text, true);
      const entry = { node, timeoutId: null };
      entry.timeoutId = setTimeout(() => {
        dropNode();
        const i = failedConfirmNodes.indexOf(entry);
        if (i !== -1) failedConfirmNodes.splice(i, 1);
      }, RESULT_NOTE_MS);
      failedConfirmNodes.push(entry);
    }
    showBadgeNote(failText);
  }

  function showBadgeNote(text) {
    const prevDetail = badgeState.detail;
    badgeNote = { text, until: Date.now() + RESULT_NOTE_MS };
    setBadge({ detail: text });
    setTimeout(() => {
      if (badgeState.detail !== text) return; // значок уже сменился по другой причине
      setBadge({ detail: badgeState.kind === 'running' ? runningDetail() : prevDetail });
    }, RESULT_NOTE_MS);
  }

  /* ==================== плашка «компьютер спал» ==================== */
  function onSlept(payload) {
    clear(dom.slept);
    dom.slept.hidden = false;
    dom.slept.appendChild(h('p', { text: `Компьютер спал с ${hhmm(payload.from)} по ${hhmm(payload.to)}` }));
    dom.slept.appendChild(h('button', { class: 'esh-btn', text: '✕', onclick: () => { dom.slept.hidden = true; } }));
  }

  // Minor/M-1: сразу после старта/возобновления показываем «первая проверка
  // через минуту», а не выдуманное «проверено в <время старта>» — реальное
  // время берём из core.status().lastCheckAt: его ставит только настоящая
  // проверка (lastTickAt ядро взводит и при start()).
  function runningDetail() {
    if (badgeNote && Date.now() < badgeNote.until) return badgeNote.text;
    badgeNote = null;
    const t = core.status().lastCheckAt;
    return t ? 'проверено в ' + hhmm(t) : 'ожидаю первую проверку';
  }

  /* ==================== события ядра ==================== */
  function initErrorBadge(e) {
    if (e && e.name === 'IdentityError') {
      return { kind: 'needIdentity', text: '🔒 Не нашла полис и дату рождения', detail: 'Откройте на сайте раздел «Полисы ОМС», дождитесь загрузки и нажмите ещё раз' };
    }
    return { kind: 'needLogin', text: '🔒 Войдите в ЕМИАС', detail: e && e.message };
  }

  function onBooked(payload) {
    if (payload.afterStop) {
      if (badgeState.kind === 'idle' && !wizard.open && !wizardLoading) {
        setBadge({ detail: 'Ранее отправленный запрос подтверждён. Посмотрите приём в ЕМИАС.' });
      }
      return;
    }
    notify('ЕМИАС: записано', 'Подробности во вкладке ЕМИАС.');
    pushLog({ at: Date.now(), msg: `Записано: ${payload.title} — ${ui.human(payload.slot.startTime)}` });
    const cfg = ui.loadConfig(storage);
    const nextCfg = ui.applyBookedUpdate(cfg, payload);
    if (nextCfg) ui.saveConfig(storage, { ...nextCfg, lastBooked: { title: payload.title, startTime: payload.slot.startTime, address: payload.address || null } });
    // Minor: раньше при возврате из «Записано» цвет менялся обратно, а текст
    // оставался старым («🟠 Записано: …») — запоминаем значок целиком (а не
    // только его kind), чтобы вернуть и текст тоже.
    if (badgeState.kind !== 'booked') preBookedBadge = { ...badgeState };
    if (!showBookedBadge()) setBadge({ kind: 'booked', text: '🟠 Записано: ' + payload.title, detail: '' });
  }

  // Показываем результат, пока пользователь не откроет панель.
  function showBookedBadge() {
    const cfg = ui.loadConfig(storage);
    const b = cfg && cfg.lastBooked;
    if (!b) return false;
    setBadge({ kind: 'booked', text: '🟠 Записано: ' + b.title, detail: b.startTime ? 'на ' + ui.human(b.startTime) + ' — нажмите, чтобы посмотреть' : '' });
    return true;
  }

  function acknowledgeBooked() {
    const cfg = ui.loadConfig(storage);
    if (cfg && cfg.lastBooked) { const next = { ...cfg }; delete next.lastBooked; ui.saveConfig(storage, next); }
    if (core.status().running) setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
    else if (finishedAll) setBadge({ kind: 'finished', text: 'Поиск завершён', detail: '' });
    else if (preBookedBadge) setBadge(preBookedBadge);
  }

  // Цель завершена сама (например, до записи осталось мало времени) — если
  // так завершились все цели, поиск останавливаем: ходить в ЕМИАС незачем.
  // Раннер перевёл цель новой записи в перенос уже существующей записи по
  // направлению. Сохраняем новые поля так же, как после 'booked', но без
  // уведомления «Записано»: записи в этот момент никто не делал.
  function onTargetUpdated(payload) {
    const cfg = ui.loadConfig(storage);
    const nextCfg = ui.applyBookedUpdate(cfg, payload);
    if (nextCfg !== cfg) ui.saveConfig(storage, nextCfg);
  }

  function onTargetDone(payload) {
    pushLog({ at: Date.now(), msg: `${payload.title}: ${payload.message}` });
    const all = core.status().targets;
    if (!all.length || !all.every((t) => t.state === 'done' || t.state === 'stopped')) return;
    core.clearSession();
    stopStatusRefresh();
    clearAllConfirmCards();
    finishedAll = true;
    const stopped = all.some((t) => t.state === 'stopped');
    if (!showBookedBadge()) setBadge({
      kind: 'finished', text: 'Поиск завершён',
      detail: stopped ? 'Проверьте результат во вкладке ЕМИАС' : 'Все цели выполнены',
    });
  }

  function onFound(payload) {
    if (payload && payload.targetId) foundCount[payload.targetId] = (foundCount[payload.targetId] || 0) + 1;
    pushLog({ at: Date.now(), msg: `${titleFor(payload.targetId)}: ${payload.warning || 'проверила расписание'}` });
  }

  function onLog(payload) { pushLog(payload); }

  function onSessionLost(payload) {
    const message = core.status().booking ? 'Проверьте, успел ли измениться приём в ЕМИАС.' : payload?.message;
    resetSearch();
    setBadge({ kind: 'needLogin', text: '🔴 Настройте поиск заново', detail: message || '' });
  }

  function onStale(payload) {
    if (badgeState.kind !== 'booked') {
      setBadge({ kind: 'stale', text: '🔴 Давно нет ответа от ЕМИАС', detail: 'с ' + hhmm(payload.since) });
    }
  }

  function onStandby() {
    resetSearch();
    setBadge({ kind: 'standby', text: '↔ Поиск идёт в другой вкладке', detail: '' });
  }

  function onNeedDryRun(payload) {
    resetSearch();
    setBadge({ kind: 'idle', text: '🎯 Настроить', detail: payload?.message || '' });
  }

  // I10: исключение в любом обработчике не должно вылетать из emit() внутри
  // tick() и останавливать поиск навсегда при зелёном значке.
  function safe(fn) {
    return (payload) => {
      try { fn(payload); } catch (e) { try { console.error('emias-slot-hunter: обработчик события упал', e); } catch (e2) { /* даже это необязательно */ } }
    };
  }

  function subscribeCore() {
    core.on('log', safe(onLog));
    core.on('found', safe(onFound));
    core.on('booked', safe(onBooked));
    core.on('targetUpdated', safe(onTargetUpdated));
    core.on('targetDone', safe(onTargetDone));
    core.on('needConfirm', safe(onNeedConfirm));
    core.on('sessionLost', safe(onSessionLost));
    core.on('stale', safe(onStale));
    core.on('slept', safe(onSlept));
    core.on('standby', safe(onStandby));
    core.on('needDryRun', safe(onNeedDryRun));
  }

  function startStatusRefresh() {
    stopStatusRefresh();
    statusRefreshId = setInterval(() => {
      const status = core.status();
      if (!status.running) return;
      try { core.checkSession(); }
      catch (e) { onSessionLost({ message: e.message }); return; }
      if (Date.now() - status.lastOkAt > 90000) onStale({ since: status.lastOkAt });
      else if (badgeState.kind !== 'booked') setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
      if (panelMode === 'status') renderStatusPanel();
    }, 5000);
  }

  function stopStatusRefresh() {
    if (statusRefreshId) clearInterval(statusRefreshId);
    statusRefreshId = null;
  }

  /* ==================== запуск ==================== */
  function boot() {
    mountBadge();
    const timer = createWorkerTimer();
    let channel = null;
    try { channel = new BroadcastChannel('emias-slot-hunter'); } catch (e) { channel = null; }
    core = create({ storage: siteStorage, fetch: window.fetch.bind(window), now: () => Date.now(), timer, channel });
    subscribeCore();
    setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
  }

  boot();
})();

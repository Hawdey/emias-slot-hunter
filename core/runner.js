// core/runner.js — цикл проверок целей: обязательный холостой прогон перед
// стартом, обнаружение сна компьютера, «протухание» проверок и режим
// подтверждения. Время приходит только через now()/timer — прямой
// Date.now()/setTimeout здесь не используются, чтобы тесты были быстрыми и
// детерминированными.
(function (root) {
  'use strict';

  function hash(obj) {
    const s = JSON.stringify(obj);
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return 'dr' + Math.abs(h);
  }

  // Поля, которые finish() может изменить сам при keepImproving после
  // успешной мутации (перенос на более удобное время). Их исключаем из
  // отпечатка гейта холостого прогона — иначе успешный перенос будет каждый
  // раз ложно требовать новый холостой прогон, хотя человек ничего не менял.
  function gateFingerprint(list) {
    return hash(list.map((t) => {
      const { current, source, scenario, ...rest } = t;
      return rest;
    }));
  }

  function createRunner({ targets, api, session, timer, now, emit, config }) {
    const state = {
      running: false,
      list: [],
      byId: {},
      confirmed: null,
      lastReport: null,
      lastTickAt: 0,
      // Время последней НАСТОЯЩЕЙ проверки — ставится только в tick().
      // lastTickAt при start() тоже взводится (точка отсчёта для обнаружения
      // сна), поэтому для показа «проверено в …» он не годится.
      lastCheckAt: 0,
      lastOkAt: 0,
      staleNotified: false,
      pending: {},
      leadershipHandlers: [],
    };
    let generation = 0;
    let offerSequence = 0;
    let booking = null;
    const isCurrent = (run) => state.running && run === generation
      && state.confirmed === gateFingerprint(state.list);
    const aborted = () => ({ ok: false, aborted: true, message: 'Запись больше не актуальна.' });

    const log = (msg) => emit('log', { at: now(), msg });
    // Нижняя граница интервала — 30 секунд, чтобы не нагружать ЕМИАС, даже
    // если когда-нибудь захочется настроить более «быстрый» slowMs.
    const interval = () => Math.max(config.minIntervalMs, config.slowMs);

    function setTargets(list) {
      const wasRunning = state.running;
      if (wasRunning) stop();
      else generation++;
      state.list = list.map((t) => ({ ...t }));
      state.byId = {};
      state.pending = {};
      for (const t of state.list) state.byId[t.id] = { state: 'idle', note: '' };
      // Смена целей обнуляет подтверждение холостого прогона — иначе можно
      // было бы подтвердить одни цели, а незаметно подставить другие.
      // lastReport тоже устаревает — иначе confirmDryRun() смог бы принять
      // id старого отчёта, снятого по прежнему списку целей.
      state.confirmed = null;
      state.lastReport = null;
      if (wasRunning) emit('needDryRun', { message: 'цели изменились — нужен новый холостой прогон' });
    }

    async function appointments() {
      const r = await api.post('v10/saOrchestrator/getAppointmentReceptionsByPatient', {});
      const list = r.json?.payload?.appointment;
      if (!r.ok || !Array.isArray(list) || list.some((a) => a?.id == null || typeof a.startTime !== 'string')) {
        throw new Error('Не удалось получить список записей ЕМИАС. Запись приостановлена до успешной проверки.');
      }
      return list;
    }

    // Запись, которая уже есть по направлению цели новой записи (bookLab,
    // bookDoctor, bookLdp). Кровь узнаём по МО и виду анализа (у таких
    // назначений нет номера направления), врача и исследование — по номеру
    // направления в самой записи.
    function existingAppointment(t, appts) {
      const s = t.source || {};
      if (t.scenario === 'bookLab') {
        return appts.find((a) => a.toBM && Number(a.toBM.id) === Number(s.samplingTypeId) && String(a.lpuId) === String(s.moId)) || null;
      }
      if (t.scenario === 'bookDoctor' || t.scenario === 'bookLdp') {
        if (s.referralId == null) return null;
        const kind = t.scenario === 'bookDoctor' ? 'toDoctor' : 'toLdp';
        return appts.find((a) => a[kind] && a.referral && String(a.referral.referralId) === String(s.referralId)) || null;
      }
      return null;
    }

    // Перед поиском сверяем цель новой записи со списком записей: если по
    // направлению запись уже есть (была при старте, охотник поймал её, но
    // ответ потерялся, или человек записался сам), цель становится переносом
    // этой записи и дальше ищет слот раньше неё. Без этого охотник продолжал
    // искать новую запись по уже занятому направлению и получал от ЕМИАС
    // ошибку на каждой проверке. Возвращает true, если цель изменилась.
    function adoptExisting(t, appts) {
      const a = existingAppointment(t, appts);
      if (!a || !a.startTime) return false;
      const when = a.startTime.slice(0, 16).replace('T', ' ');
      if (t.keepImproving === false) {
        const message = `по направлению уже есть запись на ${when}`;
        state.byId[t.id] = { state: 'done', note: message };
        emit('targetDone', { targetId: t.id, title: t.title, message });
        return true;
      }
      t.current = /(?:Z|[+-]\d\d:?\d\d)$/.test(a.startTime) ? a.startTime : a.startTime + '+03:00';
      if (t.scenario === 'bookDoctor') {
        t.source = {
          ...t.source, appointmentId: a.id, lpuId: a.lpuId || t.source.lpuId,
          specialityName: (a.toDoctor && a.toDoctor.specialityName) || t.title,
          availableResourceId: a.toDoctor?.availableResourceId ?? a.availableResourceId ?? null,
          doctorName: a.toDoctor?.doctorFio || null,
        };
        t.scenario = 'shiftDoctor';
      } else if (t.scenario === 'bookLdp') {
        t.source = { ...t.source, appointmentId: a.id, lpuId: a.lpuId || t.source.lpuId };
        t.scenario = 'shiftLdp';
      } else {
        t.source = { ...t.source, appointmentId: a.id, moId: a.lpuId || t.source.moId };
        t.scenario = 'shiftLab';
      }
      log(`${t.title}: по направлению уже есть запись на ${when} — ищу слот раньше и переношу`);
      // Обвязка сохраняет цели отдельно (см. C1 в finish()), поэтому новые
      // current/source/scenario отдаём событием, как и после своей записи.
      emit('targetUpdated', { targetId: t.id, title: t.title, current: t.current, source: t.source, scenario: t.scenario });
      return true;
    }

    function buildWarnings(t, best, r, appts) {
      const w = [];
      if (best && t.addressContains && !best.address.toLowerCase().includes(String(t.addressContains).toLowerCase())) {
        w.push(`Адрес «${best.address}» не содержит «${t.addressContains}»`);
      }
      if (best && t.current && !t.anyTime && !t.near && new Date(best.slot.startTime) > new Date(t.current)) {
        w.push('Найденный слот позже текущей записи');
      }
      if (!best && r.rejected.length) {
        const why = {};
        for (const x of r.rejected) why[x.reason] = (why[x.reason] || 0) + 1;
        w.push('Слоты есть, но все отброшены: ' + Object.entries(why).map(([k, v]) => `${k} (${v})`).join(', '));
      }
      if (best) {
        const sameDay = appts.filter((a) => a.startTime.slice(0, 10) === best.slot.startTime.slice(0, 10));
        if (sameDay.length) w.push(`В этот день уже есть записи: ${sameDay.length}`);
      }
      return w;
    }

    async function dryRun() {
      const version = generation;
      const appts = await appointments();
      if (version !== generation) throw new Error('Цели изменились. Повторите проверку.');
      const items = [];
      for (const t of state.list) {
        const existing = existingAppointment(t, appts);
        if (existing) {
          const note = t.keepImproving ? 'По направлению уже есть запись. Поиск будет искать время для переноса.'
            : 'По направлению уже есть запись. Новая запись не требуется.';
          items.push({ targetId: t.id, title: t.title, would: null, waiting: false, warnings: [], notes: [note] });
          continue;
        }
        let r;
        try {
          r = await targets.search(t, { now: now(), appointments: appts, active: () => version === generation });
        } catch (e) {
          // Холостой прогон не должен падать целиком из-за одной сбойной
          // цели — иначе человек не увидит отчёт по остальным целям и не
          // сможет ничего подтвердить. Сбой показываем как предупреждение.
          items.push({
            targetId: t.id, title: t.title, would: null, waiting: true,
            warnings: ['Проверка не выполнена: ' + (e && e.message)], notes: [],
          });
          continue;
        }
        if (version !== generation) throw new Error('Цели изменились. Повторите проверку.');
        const best = r.candidates[0] || null;
        items.push({
          targetId: t.id, title: t.title,
          would: best ? { ...best.slot, address: best.address, doctorName: best.doctorName } : null,
          waiting: !best,
          warnings: buildWarnings(t, best, r, appts),
          notes: r.notes,
        });
      }
      if (version !== generation) throw new Error('Цели изменились. Повторите проверку.');
      const report = { id: hash({ list: state.list, at: now() }), items, targetsHash: gateFingerprint(state.list) };
      state.lastReport = report;
      return report;
    }

    function confirmDryRun(id) {
      if (!state.lastReport || state.lastReport.id !== id) throw new Error('отчёт устарел, повторите холостой прогон');
      // Подтверждение фиксируется по отпечатку целей на момент этого отчёта
      // (см. gateFingerprint) — снимок, который переживает последующие
      // мутации current/source/scenario из keepImproving.
      state.confirmed = state.lastReport.targetsHash;
    }

    async function start() {
      if (state.confirmed !== gateFingerprint(state.list)) throw new Error('сначала холостой прогон и подтверждение');
      generation++;
      state.pending = {};
      state.running = true;
      state.lastTickAt = now();
      state.lastCheckAt = 0; // в этом запуске проверок ещё не было
      // Точка отсчёта для обнаружения «протухания»: считаем именно от
      // старта, а не только от последней УДАЧНОЙ проверки — иначе если ни
      // одной успешной проверки так и не случится, stale не придёт никогда.
      state.lastOkAt = now();
      state.staleNotified = false;
      schedule();
    }

    function stop() {
      generation++;
      state.running = false;
      state.pending = {};
      timer.cancel();
    }

    function schedule() {
      if (!state.running) return;
      const base = interval();
      // Небольшой джиттер (±20%), чтобы не долбить ЕМИАС строго по таймеру.
      // minIntervalMs — жёсткий пол ПОСЛЕ джиттера: даже нижняя граница
      // джиттера не должна увести фактическую задержку ниже 30 секунд.
      const jittered = Math.round(base * (0.8 + Math.random() * 0.4));
      const run = generation;
      timer.schedule(Math.max(config.minIntervalMs, jittered), () => {
        if (run === generation) return tick();
      });
    }

    async function finish(t, cand, run, expiresAt = Infinity) {
      if (booking || !isCurrent(run)) return aborted();
      booking = finishBooking(t, cand, run, expiresAt);
      try {
        return await booking;
      } finally {
        booking = null;
      }
    }

    async function finishBooking(t, cand, run, expiresAt) {
      const canSend = () => isCurrent(run) && now() < expiresAt && now() >= api.backoffUntil();
      if (!canSend()) return aborted();
      const scope = session.assertContext?.();
      const canVerify = () => {
        try { session.assertContext?.(scope); return true; }
        catch (e) { return false; }
      };
      const appts = await appointments();
      if (!canSend()) return aborted();
      if (existingAppointment(t, appts)) {
        adoptExisting(t, appts);
        return { ok: false, message: 'По этому направлению уже есть запись. Проверьте её в ЕМИАС.' };
      }
      const ctx = { now: now(), appointments: appts, canSend, canVerify };
      const res = targets.validateCandidate?.(t, cand, ctx) || await targets.act(t, cand, ctx);
      if (res.aborted) return aborted();
      if (!isCurrent(run)) {
        // Проверяем уже отправленный запрос в прежней сессии. Его результат
        // не должен менять состояние нового запуска.
        if (res.ok && res.verified && canVerify()) emit('booked', { afterStop: true });
        return aborted();
      }

      if (res.ok && res.verified) {
        state.byId[t.id] = { state: t.keepImproving ? 'improving' : 'done', note: res.message };
        if (t.keepImproving && res.newAppointment) {
          const start = res.newAppointment.startTime;
          t.current = /(?:Z|[+-]\d\d:?\d\d)$/.test(start) ? start : start + '+03:00';
          const wasBookDoctor = t.scenario === 'bookDoctor';
          t.source = { ...t.source, appointmentId: res.newAppointment.id, moId: res.newAppointment.lpuId || t.source.moId };
          if (wasBookDoctor) {
            // Как и bookLab → shiftLab: после первой успешной записи по направлению
            // цель становится переносом уже СВОЕЙ записи. lpuId и specialityName
            // берём из только что созданной записи (appointmentId уже выставлен
            // строкой выше) — они нужны переносу для описания цели.
            t.source = {
              ...t.source, lpuId: res.newAppointment.lpuId || t.source.lpuId,
              specialityName: (res.newAppointment.toDoctor && res.newAppointment.toDoctor.specialityName) || t.title,
              availableResourceId: res.newAppointment.toDoctor?.availableResourceId ?? res.newAppointment.availableResourceId ?? cand.resourceId,
              doctorName: res.newAppointment.toDoctor?.doctorFio || cand.doctorName || null,
            };
            t.scenario = 'shiftDoctor';
          } else if (t.scenario === 'bookLab') {
            t.scenario = 'shiftLab';
          } else if (t.scenario === 'bookLdp') {
            // referralId и ldpTypeId остаются в source — они нужны переносу.
            t.source = { ...t.source, lpuId: res.newAppointment.lpuId || t.source.lpuId };
            t.scenario = 'shiftLdp';
          }
        }
        // Интерфейс показывает обновлённую цель после переноса.
        emit('booked', {
          targetId: t.id, title: t.title, slot: cand.slot, address: cand.address, message: res.message,
          current: t.current, source: t.source, scenario: t.scenario,
        });
        if (!t.keepImproving) emit('targetDone', { targetId: t.id, title: t.title, message: res.message });
        return res;
      }

      if (res.ok && !res.verified) {
        const message = 'Результат не подтверждён. Цель остановлена. Проверьте приём в ЕМИАС.';
        state.byId[t.id] = { state: 'stopped', note: message };
        emit('found', { targetId: t.id, warning: message, slot: cand.slot, address: cand.address });
        emit('targetDone', { targetId: t.id, title: t.title, message });
        return res;
      }

      // !res.ok — смотрим на action.
      if (res.action === 'stopTarget') {
        state.byId[t.id] = { state: 'stopped', note: res.message };
        emit('targetDone', { targetId: t.id, title: t.title, message: res.message });
      } else if (res.action === 'relogin') {
        loseSession(res.message);
        return res;
      }
      // 'wait' | 'switchToShift' | 'retry' | null — обычный повтор на
      // следующем тике, состояние цели не меняем.
      emit('found', { targetId: t.id, warning: res.message, slot: cand.slot, address: cand.address });
      return res;
    }

    // Ответ пользователя на needConfirm (режим mode: 'confirm'). Раннер
    // может быть уже остановлен между needConfirm и ответом человека (или
    // намеренно, или из-за stop()) — в этом случае ничего в ЕМИАС не шлём,
    // заявка остаётся нетронутой на случай последующего запуска.
    async function answer(targetId, decision, offerId) {
      if (!state.running) return { ok: false, message: 'раннер остановлен, ответ не отправлен' };
      const p = state.pending[targetId];
      if (!p || (offerId != null && offerId !== p.offerId)) return aborted();
      delete state.pending[targetId];
      if (now() >= p.expiresAt) return aborted();
      if (decision !== 'book') {
        log(`${p.target.title}: пользователь отклонил слот`);
        return { ok: false };
      }
      const run = generation;
      try { return await finish(p.target, p.candidate, run, p.expiresAt); }
      catch (e) {
        if (!isCurrent(run)) return aborted();
        if (e?.name === 'SessionError') loseSession(e.message);
        throw e;
      }
    }

    function loseSession(message) {
      stop();
      session.clear?.();
      emit('sessionLost', { message });
    }

    async function tick() {
      if (!state.running) return;

      // C2: гейт холостого прогона проверяем не только в start(), но и на
      // каждом тике — setTargets() может прийти уже во время работающего
      // цикла (мастер меняет условия, пока человек ещё читает холостой
      // прогон), и цикл не должен продолжать работать по неподтверждённым
      // целям до следующего запланированного tick().
      if (state.confirmed !== gateFingerprint(state.list)) {
        stop();
        emit('needDryRun', { message: 'цели изменились — нужен новый холостой прогон' });
        return;
      }
      const run = generation;
      const active = () => isCurrent(run);

      // Обнаружение сна компьютера/вкладки: если между тиками прошло сильно
      // больше, чем должно быть по расписанию, — это не «мы решили не
      // проверять», а комп/браузер были неактивны.
      const gap = now() - state.lastTickAt;
      if (state.lastTickAt && gap > interval() * config.sleepFactor) {
        emit('slept', { from: state.lastTickAt, to: now(), missed: Math.round(gap / interval()) });
      }
      state.lastTickAt = now();
      state.lastCheckAt = now();

      try {
        session.assertContext?.();
        if (now() >= api.backoffUntil()) {
          const appts = await appointments();
          if (!active()) return;
          // Ошибки запросов расписания не засчитываем как успешную проверку.
          let searchOk = true;
          targetsLoop:
          for (const t of state.list) {
            // C2: backoffUntil проверяли только один раз в начале tick() (выше) — но
            // targets.search() сам может нарваться на 429 ПОСЕРЕДИНЕ этого перебора
            // (например, у первой цели), и тогда без этой проверки раннер всё равно
            // продолжил бы дёргать ЕМИАС по остальным целям в том же тике.
            if (!active()) return;
            if (now() < api.backoffUntil()) { searchOk = false; break targetsLoop; }
            const st = state.byId[t.id];
            // 'improving' — цель уже выполнена один раз, но keepImproving
            // просит продолжать искать более удобный слот, поэтому такую
            // цель не пропускаем, в отличие от 'done' и 'stopped'.
            if (st.state === 'done' || st.state === 'stopped') continue;
            if (state.pending[t.id] || booking) continue;

            // Запись по направлению могла появиться во время работы (в том
            // числе руками на сайте) — тогда переходим в перенос, а не ищем
            // новую запись по занятому направлению.
            if (adoptExisting(t, appts) && state.byId[t.id].state === 'done') continue;

            // Текущая запись уже скоро (или прошла) — переносить её некуда:
            // слоты раньше неё отсеет minLeadMs, а ЕМИАС на перенос начавшейся
            // записи отвечает ошибкой. Завершаем цель, а не долбим сайт.
            if (t.current && Date.parse(t.current) - now() < (t.minLeadMs || 0)) {
              const message = `запись на ${String(t.current).slice(0, 16).replace('T', ' ')} уже скоро или прошла — больше не переношу`;
              state.byId[t.id] = { state: 'done', note: message };
              emit('targetDone', { targetId: t.id, title: t.title, message });
              continue;
            }

            const r = await targets.search(t, { now: now(), appointments: appts, active });
            if (!active()) return;
            if (r.action === 'wait' || r.action === 'retry') searchOk = false;

            if (r.action === 'stopTarget') {
              const message = (r.notes && r.notes.join('; ')) || 'цель остановлена';
              state.byId[t.id] = { state: 'stopped', note: message };
              // Та же реакция, что и на stopTarget из act() (см. finish()) —
              // кто следит только за событиями, должен узнать об остановке,
              // а не только по опросу status().
              emit('found', { targetId: t.id, warning: message, slot: null, address: null });
              emit('targetDone', { targetId: t.id, title: t.title, message });
              continue;
            }
            if (r.action === 'relogin') {
              loseSession((r.notes && r.notes.join('; ')) || 'Вход в ЕМИАС закончился.');
              return;
            }

            if (!r.candidates.length) {
              if (r.notes && r.notes.length) log(`${t.title}: ${r.notes.join('; ')}`);
              continue;
            }

            const cand = r.candidates[0];
            if (t.mode === 'confirm') {
              const expiresAt = now() + 60000;
              const offerId = ++offerSequence;
              state.pending[t.id] = { target: t, candidate: cand, expiresAt, offerId };
              emit('needConfirm', {
                targetId: t.id, title: t.title, slot: cand.slot, address: cand.address,
                doctorName: cand.doctorName, expiresAt, offerId,
              });
              continue;
            }

            const res = await finish(t, cand, run);
            if (!active() || res.action === 'relogin') return;
          }
          if (searchOk && now() >= api.backoffUntil()) {
            state.lastOkAt = now();
            state.staleNotified = false;
          }
        }
      } catch (e) {
        if (!active()) return;
        if (e?.name === 'SessionError') { loseSession(e.message); return; }
        log('Не удалось завершить проверку. Повторю поиск.');
      }

      // Протухание: считаем от старта/последней удавшейся проверки. Как
      // только разрыв достиг трёх интервалов — сообщаем один раз и молчим
      // до следующей удачной проверки (staleNotified сбрасывается выше).
      if (now() - state.lastOkAt >= interval() * config.staleFactor && !state.staleNotified) {
        state.staleNotified = true;
        emit('stale', { since: state.lastOkAt });
      }

      for (const [id, p] of Object.entries(state.pending)) {
        if (now() > p.expiresAt) { delete state.pending[id]; log('подтверждение не получено, слот пропущен'); }
      }

      schedule();
    }

    function status() {
      return {
        running: state.running,
        booking: Boolean(booking),
        confirmed: state.confirmed === gateFingerprint(state.list),
        lastTickAt: state.lastTickAt,
        lastCheckAt: state.lastCheckAt,
        lastOkAt: state.lastOkAt,
        sessionRefreshedAt: session.refreshedAt,
        targets: state.list.map((t) => ({ id: t.id, title: t.title, current: t.current || null, ...state.byId[t.id] })),
        pending: Object.keys(state.pending),
      };
    }

    // Единая вкладка: у самого core/runner.js в зависимостях фабрики нет
    // ничего для межвкладочной координации (BroadcastChannel/локальная
    // блокировка и т.п. — их нет в списке Consumes этой задачи), поэтому
    // фактический выбор «лидера» среди вкладок браузера — забота обвязки
    // вне core/. Здесь — точка расширения: с точки зрения одного экземпляра
    // раннера он всегда лидер.
    function onLeadership(fn) {
      state.leadershipHandlers.push(fn);
      fn(true);
      return () => { state.leadershipHandlers = state.leadershipHandlers.filter((f) => f !== fn); };
    }

    return { setTargets, dryRun, confirmDryRun, start, stop, tick, answer, status, onLeadership, inFlightBooking: () => booking };
  }

  const api = { createRunner };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

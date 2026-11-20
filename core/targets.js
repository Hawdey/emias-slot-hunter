// core/targets.js — новая запись по направлению: на анализ крови (bookLab), к врачу
// (bookDoctor), на исследование (bookLdp) — и перенос существующих записей
// (shiftLab, shiftLdp, shiftDoctor).
(function (root) {
  'use strict';

  function createTargets({ api, filters, util }) {
    const { toMs, campus } = util;

    // Поддерживаются только эти сценарии. Всё остальное (например,
    // bookReferral — направление непонятного вида) в v0.1 не
    // реализовано: явный белый список не даёт случайно уйти в сетевой
    // запрос с недостающими полями (например, appointmentId === undefined).
    const SUPPORTED_SCENARIOS = new Set(['bookLab', 'shiftLab', 'shiftLdp', 'shiftDoctor', 'bookDoctor', 'bookLdp']);
    const UNSUPPORTED_MESSAGE = 'Этот вид записи пока не поддерживается';
    const NEED_PURPOSE_MESSAGE = 'Для этого направления нужно выбрать цель визита';

    // Рекурсивно собираем доступные ресурсы (кабинеты/врачей) из ответа ЕМИАС.
    // Ветки notAvailable* пропускаем — это места, где приёма нет; собственные
    // флаги узла (notAvailable: true / available: false) проверяем отдельно,
    // т.к. ЕМИАС иногда помечает недоступность прямо на самом ресурсе, а не
    // только через обёртку notAvailableResources. Дедуплицируем по id — один
    // и тот же кабинет может встретиться в дереве несколько раз.
    function collectResources(payload, includeUnavailable = false) {
      const out = [];
      const seen = new Set();
      (function walk(node, notAvail) {
        if (Array.isArray(node)) { node.forEach((n) => walk(n, notAvail)); return; }
        if (!node || typeof node !== 'object') return;
        const selfNotAvail = node.notAvailable === true || node.available === false;
        for (const [k, v] of Object.entries(node)) {
          if (v && typeof v === 'object') walk(v, notAvail || selfNotAvail || /notAvailable/i.test(k));
        }
        if ((includeUnavailable || (!notAvail && !selfNotAvail))
            && node.id && Array.isArray(node.complexResource) && 'arType' in node && !seen.has(String(node.id))) {
          seen.add(String(node.id));
          out.push(node);
        }
      })(payload, false);
      return out;
    }

    // Адрес кабинета берём только при точном совпадении id — раньше при
    // рассинхронизации id молча подставлялся адрес первого кабинета в
    // списке, из-за чего человек мог записаться по чужому адресу в обход
    // фильтра addressContains. Сравниваем строками — id из разных ответов
    // ЕМИАС иногда приходят числом и строкой.
    function scheduleAddress(payload, crId) {
      const crs = (payload && payload.availableResource && payload.availableResource.complexResource) || [];
      const cr = crs.find((c) => String(c.id) === String(crId));
      return (cr && cr.room && cr.room.defaultAddress) || '';
    }

    function scheduleSlots(payload, crId) {
      const out = [];
      for (const day of (payload && payload.scheduleOfDay) || [])
        for (const sb of day.scheduleBySlot || [])
          if (!sb.complexResourceId || String(sb.complexResourceId) === String(crId))
            for (const sl of sb.slot || []) out.push(sl);
      return out.sort((a, b) => toMs(a.startTime) - toMs(b.startTime));
    }

    // bookLab, bookDoctor и bookLdp — сценарии новой записи; остальные — переносы
    // существующих записей и требуют appointmentId в каждом запросе к ЕМИАС.
    const isShift = (t) => !['bookLab', 'bookDoctor', 'bookLdp'].includes(t.scenario);
    const isLab = (t) => t.scenario === 'bookLab' || t.scenario === 'shiftLab';
    const isReferralBooking = (t) => t.scenario === 'bookDoctor' || t.scenario === 'bookLdp';
    const isDoctor = (t) => t.scenario === 'shiftDoctor' || t.scenario === 'bookDoctor';
    const sameResource = (a, b) => a != null && a !== '' && b != null && b !== '' && String(a) === String(b);
    const addressKey = (address) => String(address || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
    const exactAddresses = (t) => Array.isArray(t.exactAddresses) && t.exactAddresses.length
      ? t.exactAddresses : t.addressExact ? [t.addressExact] : [];
    function matchesAddress(t, address) {
      const key = addressKey(address);
      const allowed = exactAddresses(t);
      return (!allowed.length || allowed.some((entry) => addressKey(entry) === key))
        && (!t.addressContains || key.includes(addressKey(t.addressContains)));
    }
    const sameDoctorShift = (t) => t.scenario === 'shiftDoctor' && t.sameDoctor === true;
    const requiresDoctor = (t) => sameDoctorShift(t) || (t.scenario === 'bookDoctor' && !!t.source.availableResourceId);
    const doctorMismatch = () => ({
      ok: false, action: 'stopTarget', message: 'Не удалось подтвердить выбранного врача. Настройте поиск заново.',
    });

    // Дата из SA_REFERRAL_FOR_FUTURE ограничивает даты слотов. Её можно
    // использовать в запросе сразу, не дожидаясь наступления этого дня.
    const earliestDays = new WeakMap();
    const roomProgress = new WeakMap();
    const resourceCache = new WeakMap();
    const RESOURCE_CACHE_MS = 120000;
    const defaultEnd = (now) => util.mskDate(new Date(now + 30 * 24 * 3600000));

    function period(t, now, earliestDay) {
      const today = util.mskDate(new Date(now));
      const first = [today, t.onlyDay, t.dateFrom, earliestDay].filter(Boolean).sort().at(-1);
      const currentDay = t.current && !t.anyTime ? t.current.slice(0, 10) : null;
      const last = [t.onlyDay, currentDay, t.dateTo, t.deadline?.slice(0, 10)].filter(Boolean).sort()[0]
        || defaultEnd(now);
      return { dateFrom: first, dateTo: last };
    }

    function requestPeriod(t, now, selected, earliestDay) {
      const horizon = defaultEnd(now);
      if (!isLab(t) || selected.dateTo > horizon) return selected;
      // Календарь ЕМИАС запрашивает лаборатории и их расписание на 30 дней.
      // Узкий запрос на одну дату может быть отклонён даже для доступного дня.
      const today = util.mskDate(new Date(now));
      return { dateFrom: earliestDay && earliestDay > today ? earliestDay : today, dateTo: horizon };
    }

    function searchFailure(message, action = null, earliestDay = null) {
      return { candidates: [], rejected: [], notes: [message], action, earliestDay };
    }

    async function listResources(t, p, active) {
      if (isLab(t)) {
        // Пока у пациента есть активная запись на это же лабораторное исследование,
        // ЕМИАС отклоняет поиск слотов для НОВОЙ записи — нужен режим переноса
        // с appointmentId и moId (lpuId) текущей записи в assignment.
        const body = t.scenario === 'bookLab'
          ? { assignment: { moId: t.source.moId, samplingTypeId: t.source.samplingTypeId, period: p } }
          : { appointmentId: t.source.appointmentId, assignment: { moId: t.source.moId, samplingTypeId: t.source.samplingTypeId, period: p } };
        return api.post('v4/saOrchestrator/getDoctorsInfoForLI', body, active);
      }
      if (isReferralBooking(t)) {
        // Новая запись по направлению — без appointmentId и без
        // purposeReceptionForm (это поле относится только к переносу).
        return api.post('v5/saOrchestrator/getDoctorsInfo', { referralId: t.source.referralId }, active);
      }
      return api.post('v5/saOrchestrator/getDoctorsInfo', { appointmentId: t.source.appointmentId, purposeReceptionForm: 'personal' }, active);
    }

    async function listDoctors(option) {
      if (option.scenario !== 'shiftDoctor') return [];
      const res = await listResources(option);
      if (!res.ok) throw new Error(res.explained?.message || 'Не удалось получить список врачей ЕМИАС.');
      const doctors = collectResources(res.json?.payload, true)
        .filter((r) => typeof r.name === 'string' && r.name.trim())
        .map((r) => ({ id: r.id, name: r.name.trim() }));
      const key = (name) => name.toLowerCase().replace(/[.\s]+/g, '');
      const counts = new Map();
      for (const { name } of doctors) counts.set(key(name), (counts.get(key(name)) || 0) + 1);
      return doctors.map((doctor) => ({ ...doctor, ambiguous: counts.get(key(doctor.name)) > 1 }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    }

    async function listAddresses(t, ctx) {
      if (ctx.now < api.backoffUntil()) throw new Error('ЕМИАС попросил паузу. Попробуйте позже.');
      const result = await search(t, { ...ctx, addressesOnly: true });
      if (!result.addresses?.length && result.action) throw new Error(result.notes[0] || 'Не удалось загрузить адреса.');
      return {
        addresses: result.addresses || [],
        notice: result.action ? 'Список загружен частично. Его можно обновить.' : '',
      };
    }

    async function search(t, ctx) {
      if (!SUPPORTED_SCENARIOS.has(t.scenario)) {
        return { candidates: [], rejected: [], notes: [UNSUPPORTED_MESSAGE], action: null };
      }
      // Направление требует выбора цели визита (needPurpose), а мастер её ещё не
      // задал (t.purpose) — без неё сайт отклоняет и расписание, и запись, поэтому
      // не делаем вообще никаких запросов, а сразу объясняем, чего не хватает.
      if (t.scenario === 'bookDoctor' && t.source.needPurpose && !t.purpose) {
        return { candidates: [], rejected: [], notes: [NEED_PURPOSE_MESSAGE], action: null };
      }
      if (sameDoctorShift(t) && !t.source.availableResourceId) {
        const failure = doctorMismatch();
        return { candidates: [], rejected: [], notes: [failure.message], action: failure.action };
      }
      const remembered = earliestDays.get(t);
      const knownDay = remembered && remembered.source === t.source ? remembered.day : null;
      const initial = period(t, ctx.now, knownDay);
      if (initial.dateFrom > initial.dateTo) {
        return searchFailure('В выбранном диапазоне нет допустимых дат для этой цели.', 'stopTarget');
      }
      const requested = requestPeriod(t, ctx.now, initial, knownDay);
      const result = await searchPeriod(t, ctx, initial, requested);
      const first = result.earliestDay;
      if (!first || (ctx.active && !ctx.active()) || ctx.now < api.backoffUntil()) return result;
      if (first > initial.dateTo) {
        return searchFailure(result.notes[0] + ' Она позже выбранного диапазона. Измените даты поиска.', 'stopTarget');
      }
      if (first <= requested.dateFrom) {
        return searchFailure(result.notes[0] + ' ЕМИАС отклонил запрос на этот период. Проверьте расписание на сайте.', 'stopTarget');
      }
      earliestDays.set(t, { source: t.source, day: first });
      const selected = period(t, ctx.now, first);
      const retry = await searchPeriod(t, ctx, selected, requestPeriod(t, ctx.now, selected, first));
      if (!retry.earliestDay) return retry;
      return searchFailure(retry.notes[0] + ' ЕМИАС отклонил уточнённый диапазон. Проверьте расписание на сайте.', 'stopTarget');
    }

    async function searchPeriod(t, ctx, selected, requested) {
      const inBackoff = () => ctx.now < api.backoffUntil();
      if (inBackoff()) return searchFailure('Проверка отложена до окончания паузы ЕМИАС.', 'wait');
      if (ctx.budget && !ctx.budget.remaining) {
        return searchFailure('Проверю расписание в следующем цикле. Лимит запросов исчерпан.');
      }
      const notes = [];
      let action = null;
      const cached = ctx.reuseResources ? resourceCache.get(t) : null;
      const periodKey = isLab(t) ? requested.dateFrom + '/' + requested.dateTo : '';
      const fromCache = cached && cached.source === t.source && cached.periodKey === periodKey && ctx.now < cached.expiresAt;
      if (!fromCache && ctx.budget) ctx.budget.remaining--;
      const res = fromCache ? cached.result : await listResources(t, requested, ctx.active);
      if (!res.ok) {
        return searchFailure(res.explained?.message || 'ЕМИАС не отдал список кабинетов',
          res.explained?.action, isLab(t) ? res.explained?.earliestDay : null);
      }
      let resources = collectResources(res.json && res.json.payload);
      if (requiresDoctor(t)) {
        resources = resources.filter((r) => sameResource(r.id, t.source.availableResourceId));
        if (!resources.length) {
          return { candidates: [], rejected: [], notes: ['ЕМИАС не предлагает расписание выбранного врача.'], action: null };
        }
      }
      if (!resources.length) return { candidates: [], rejected: [], notes: ['Свободных кабинетов или врачей сейчас нет'], action: null };
      if (ctx.reuseResources && !fromCache && (!ctx.active || ctx.active())) {
        resourceCache.set(t, { source: t.source, periodKey, expiresAt: ctx.now + RESOURCE_CACHE_MS, result: res });
      }

      const candidates = [];
      const addresses = new Map();
      const rememberAddress = (value) => {
        if (typeof value === 'string' && value.trim()) addresses.set(addressKey(value), value.trim());
      };
      let rejected = [];
      let addressMismatch = 0;
      let addressUnknown = 0;
      let doctorUnknown = false;
      const rooms = [];
      const requiresExactAddress = exactAddresses(t).length > 0;
      for (const r of resources) {
        for (const cr of r.complexResource) {
          const listedAddress = typeof cr.room?.defaultAddress === 'string' ? cr.room.defaultAddress.trim() : '';
          if (ctx.addressesOnly && listedAddress) rememberAddress(listedAddress);
          else if (requiresExactAddress && !ctx.addressesOnly && listedAddress && !matchesAddress(t, listedAddress)) addressMismatch++;
          else rooms.push({ r, cr, key: JSON.stringify([String(r.id), String(cr.id)]) });
        }
      }
      // Продолжаем незавершённый проход. Отложенный после сбоя кабинет
      // возвращается в очередь после прохода по остальным кабинетам.
      const saved = ctx.addressesOnly ? null : roomProgress.get(t);
      const range = selected.dateFrom + '/' + selected.dateTo;
      const sameSearch = saved && saved.source === t.source && saved.range === range;
      const checked = new Set(sameSearch ? saved.checked : []);
      const postponed = new Set(sameSearch ? saved.postponed : []);
      let queue = rooms.filter(({ key }) => !checked.has(key) && !postponed.has(key));
      if (!queue.length) {
        checked.clear();
        queue = rooms.filter(({ key }) => !postponed.has(key));
        if (!queue.length) {
          postponed.clear();
          queue = rooms;
        }
      }
      let pausedByBackoff = false;
      let reachedLimit = false;
      for (const { r, cr, key } of queue) {
        if (ctx.active && !ctx.active()) break;
        if (inBackoff()) { pausedByBackoff = true; break; }
        if (ctx.budget && !ctx.budget.remaining) { reachedLimit = true; break; }
        if (ctx.budget) ctx.budget.remaining--;
        checked.add(key);
        const body = { availableResourceId: r.id, complexResourceId: cr.id, period: requested };
        if (isShift(t)) body.appointmentId = t.source.appointmentId;
        // Перенос исследования иногда требует ещё и referralId — если он есть у цели, передаём сразу.
        if (isShift(t) && t.source.referralId) body.referralId = t.source.referralId;
        if (isReferralBooking(t)) {
          body.referralId = t.source.referralId;
          if (t.purpose && t.purpose.inquiryPurposeId) body.inquiryPurposeId = t.purpose.inquiryPurposeId;
        }
        const s = await api.post('v4/saOrchestrator/getAvailableResourceScheduleInfo', body, ctx.active);
        if (!s.ok) {
          if (s.explained?.action === 'stopTarget') {
            return searchFailure(s.explained.message, s.explained.action, s.explained.earliestDay);
          }
          notes.push(s.explained ? s.explained.message : 'расписание недоступно');
          action = (s.explained && s.explained.action) || action;
          if (inBackoff()) postponed.add(key);
          continue;
        }
        const payload = s.json?.payload;
        if (sameDoctorShift(t) && !sameResource(payload?.availableResource?.id, r.id)) {
          doctorUnknown = true;
          continue;
        }
        const address = scheduleAddress(payload, cr.id);
        if (!address) { addressUnknown++; continue; }
        if (ctx.addressesOnly) {
          rememberAddress(address);
          continue;
        }
        if (!matchesAddress(t, address)) { addressMismatch++; continue; }
        const slots = scheduleSlots(payload, cr.id);
        const picked = filters.pickSlots({
          slots,
          target: { ...t, dateFrom: selected.dateFrom, dateTo: selected.dateTo, selfId: t.source.appointmentId || null },
          now: ctx.now, appointments: ctx.appointments, addressOf: () => address,
        });
        // onlyIfConflict мог решить, что переносить нечего (конфликта нет) — без этой
        // строки в notes человек видел бы пустой список без объяснения причины.
        if (picked.skipped) notes.push(picked.skipped);
        rejected = rejected.concat(picked.rejected.map((x) => ({ ...x, address })));
        for (const slot of picked.ok) candidates.push({
          slot, address, resourceId: r.id, complexResourceId: cr.id, name: r.name,
          doctorName: isDoctor(t) ? (r.name || t.source.doctorName || null) : null,
        });
      }
      if (!ctx.addressesOnly && (!ctx.active || ctx.active())) {
        if (inBackoff() || reachedLimit) roomProgress.set(t, { source: t.source, range, checked, postponed });
        else roomProgress.delete(t);
      }
      const compare = filters.slotComparator(t);
      candidates.sort((a, b) => compare(a.slot, b.slot));
      if (addressUnknown) notes.push(`Не удалось определить адрес ${addressUnknown} кабинет(ов) в расписании — пропущены`);
      if (addressMismatch) notes.push(`Кабинетов с другим адресом пропущено: ${addressMismatch}`);
      if (doctorUnknown) notes.push('ЕМИАС вернул расписание без подтверждения выбранного врача. Оно пропущено.');
      if (pausedByBackoff) notes.push('После паузы сначала проверю остальные кабинеты.');
      if (reachedLimit) notes.push('Остальные кабинеты проверю в следующем цикле. Лимит запросов на этот цикл исчерпан.');
      if (ctx.addressesOnly) return { candidates, rejected, notes, action, addresses: [...addresses.values()].sort((a, b) => a.localeCompare(b, 'ru')) };
      return { candidates, rejected, notes, action };
    }

    // Проверяем, что найденная в списке запись — действительно та, что мы только что
    // создали/перенесли, а не что-то постороннее, случайно совпавшее по времени:
    //  - время начала должно совпасть со слотом;
    //  - для выбора из списка адрес совпадает полностью с адресом слота.
    //    В остальных режимах сравниваем кампус без номера корпуса;
    //  - для bookLab запись обязана получить НОВЫЙ id — ЕМИАС не присваивает новый id
    //    старой записи, поэтому id, уже бывший в списке ДО брони, не считается совпадением;
    //  - при переносе ЕМИАС выдаёт записи новый id, поэтому своей считаем запись с прежним
    //    id или новую (её не было в списке до переноса), а не любую с тем же временем;
    //  - тип записи должен соответствовать сценарию (в т.ч. конкретный вид анализа для
    //    shiftLab и конкретный ldpTypeId для shiftLdp — иначе можно принять за свою запись
    //    чужой перенесённый анализ/исследование с тем же временем).
    function matches(t, appt, cand, beforeIds) {
      if (toMs(appt.startTime) !== toMs(cand.slot.startTime)) return false;
      const sameAddress = exactAddresses(t).length ? addressKey(appt.lpuAddress) === addressKey(cand.address)
        : campus(appt.lpuAddress) === campus(cand.address);
      if (!sameAddress) return false;
      if (t.scenario === 'bookLab') {
        if (beforeIds.has(String(appt.id))) return false;
        return !!appt.toBM && Number(appt.toBM.id) === Number(t.source.samplingTypeId);
      }
      if (t.scenario === 'bookDoctor') {
        if (beforeIds.has(String(appt.id))) return false;
        return matchesDoctor(t, appt, cand);
      }
      if (t.scenario === 'bookLdp') {
        if (beforeIds.has(String(appt.id))) return false;
        return sameReferral(t, appt) && !!appt.toLdp && Number(appt.toLdp.ldpTypeId) === Number(t.source.ldpTypeId);
      }
      // Перенос: ЕМИАС выдаёт перенесённой записи новый id (проверено на живом
      // сайте — и для крови, и для приёма врача). Поэтому своя запись — либо с
      // прежним id, либо новая, которой не было в списке до переноса. Запись,
      // которая уже была до переноса под другим id, — чужая.
      if (String(appt.id) !== String(t.source.appointmentId) && beforeIds.has(String(appt.id))) return false;
      if (t.scenario === 'shiftLdp') return sameReferral(t, appt) && !!appt.toLdp && Number(appt.toLdp.ldpTypeId) === Number(t.source.ldpTypeId);
      if (t.scenario === 'shiftDoctor') return matchesDoctor(t, appt, cand);
      if (t.scenario === 'shiftLab') return !!appt.toBM && Number(appt.toBM.id) === Number(t.source.samplingTypeId);
      return false;
    }

    function sameReferral(t, appt) {
      return t.source.referralId == null || (appt.referral?.referralId != null
        && String(appt.referral.referralId) === String(t.source.referralId));
    }

    function matchesDoctor(t, appt, cand) {
      const doctor = appt.toDoctor;
      if (!doctor || !sameReferral(t, appt)) return false;
      if (t.source.specialityId != null && String(doctor.specialityId) !== String(t.source.specialityId)) return false;
      if (t.source.specialityName && doctor.specialityName !== t.source.specialityName) return false;
      const resource = doctor.availableResourceId ?? appt.availableResourceId;
      if (sameDoctorShift(t)) return sameResource(resource, cand.resourceId);
      return resource == null || String(resource) === String(cand.resourceId);
    }

    // Перечитываем список записей и ищем в нём результат мутации. listRes.ok === false
    // («список недоступен») — это не то же самое, что «записи нет», поэтому у результата
    // есть отдельный флаг verifyFailed. Чтение может ещё и бросить исключение (например,
    // SessionError при повторном 401 уже ПОСЛЕ успешной записи/переноса) — такое исключение
    // не должно топить уже совершённую мутацию, поэтому оно тоже превращается в verifyFailed.
    async function verifyAppointment(t, cand, ctx) {
      const beforeIds = new Set((ctx.appointments || []).map((a) => String(a.id)));
      let listRes;
      try {
        if (ctx.canVerify && !ctx.canVerify()) return { verifyFailed: true };
        listRes = await api.post('v10/saOrchestrator/getAppointmentReceptionsByPatient', {}, ctx.canVerify);
      } catch (e) {
        return { verifyFailed: true };
      }
      if (!listRes.ok) return { verifyFailed: true };
      const appts = listRes.json?.payload?.appointment;
      if (!Array.isArray(appts)) return { verifyFailed: true };
      const found = appts.filter((a) => a?.id != null && matches(t, a, cand, beforeIds));
      return { found: found.length === 1 ? found[0] : null };
    }

    function validateCandidate(t, cand, ctx) {
      if (isShift(t)) {
        const current = ctx.appointments.find((a) => String(a.id) === String(t.source.appointmentId));
        if (!current || current.enableShift === false || toMs(current.startTime) !== toMs(t.current)
            || toMs(current.startTime) - ctx.now < (t.minLeadMs || 0)) {
          return { ok: false, action: 'stopTarget', message: 'Текущая запись изменилась или её нельзя перенести. Проверьте её в ЕМИАС.' };
        }
        const doctorId = current.toDoctor?.availableResourceId ?? current.availableResourceId;
        if (sameDoctorShift(t) && (!current.toDoctor
            || (doctorId != null && !sameResource(doctorId, t.source.availableResourceId)))) {
          return doctorMismatch();
        }
      }
      if (!matchesAddress(t, cand.address)) {
        return { ok: false, action: 'retry', message: 'Адрес больше не подходит.' };
      }
      const valid = filters.pickSlots({
        slots: [cand.slot],
        target: { ...t, selfId: t.source.appointmentId },
        now: ctx.now,
        appointments: ctx.appointments,
        addressOf: () => cand.address,
      });
      if (!valid.ok.length) return { ok: false, action: 'retry', message: 'Слот больше не подходит по времени или пересекается с другой записью.' };
      return null;
    }

    async function act(t, cand, ctx) {
      if (requiresDoctor(t) && !sameResource(cand.resourceId, t.source.availableResourceId)) return doctorMismatch();
      if (!matchesAddress(t, cand.address)) return { ok: false, action: 'retry', message: 'Адрес больше не подходит.' };
      const send = (path, body) => api.post(path, body, ctx.canSend);
      const base = {
        availableResourceId: cand.resourceId, complexResourceId: cand.complexResourceId,
        startTime: cand.slot.startTime, endTime: cand.slot.endTime,
      };
      let res;
      switch (t.scenario) {
        case 'bookLab': {
          res = await send('v4/saOrchestrator/createAppointment', base);
          break;
        }
        case 'bookDoctor': {
          const body = { ...base, referralId: t.source.referralId };
          // Цель визита уходит в запись обоими полями (id и code) только если
          // она реально была выбрана — иначе createAppointment получает лишние
          // поля, которых снятый на сайте запрос без цели не содержал.
          if (t.purpose && t.purpose.inquiryPurposeId) {
            body.inquiryPurposeId = t.purpose.inquiryPurposeId;
            body.inquiryPurposeCode = t.purpose.inquiryPurposeCode;
          }
          res = await send('v4/saOrchestrator/createAppointment', body);
          break;
        }
        case 'bookLdp': {
          res = await send('v4/saOrchestrator/createAppointment', { ...base, referralId: t.source.referralId });
          break;
        }
        case 'shiftLab':
        case 'shiftLdp':
        case 'shiftDoctor': {
          res = await send('v4/saOrchestrator/shiftAppointment', { ...base, appointmentId: t.source.appointmentId });
          // Перенос иногда проходит только со вторым параметром referralId — при отказе
          // повторяем с ним, но ТОЛЬКО при бизнес-отказе (400–499, кроме 429 и «выключить
          // цель»). При сетевой ошибке (status 0), 429 или 5xx api уже выставил паузу перед
          // следующей попыткой — слать второй запрос сразу же значит обойти эту паузу.
          const isBusinessRejection = !res.ok && res.status >= 400 && res.status < 500 && res.status !== 429
            && res.explained?.action !== 'stopTarget';
          if (isBusinessRejection && t.source.referralId) {
            res = await send('v4/saOrchestrator/shiftAppointment', { ...base, appointmentId: t.source.appointmentId, referralId: t.source.referralId });
          }
          break;
        }
        default:
          return { ok: false, verified: false, message: UNSUPPORTED_MESSAGE, action: null };
      }

      if (res.aborted) return res;
      if (!res.ok) {
        // Таймаут (status 0) или 5xx не значат, что мутация не прошла — ЕМИАС мог принять
        // запрос, но не успеть ответить вовремя. Перед вердиктом «не получилось» на всякий
        // случай перечитываем список записей: вдруг перенос/запись всё же случились.
        if (res.status === 0 || res.status >= 500 || (res.status >= 200 && res.status < 300)) {
          const verify = await verifyAppointment(t, cand, ctx);
          if (verify.found) return { ok: true, verified: true, message: 'Готово', newAppointment: verify.found, action: null };
          return { ok: true, verified: false, verifyFailed: true, message: 'Результат записи неизвестен. Проверьте записи в ЕМИАС перед повторным запуском.' };
        }
        return {
          ok: false, verified: false,
          message: (res.explained && res.explained.message) || 'ЕМИАС отказал',
          action: (res.explained && res.explained.action) || null,
        };
      }

      // После успешного ответа обязательно перечитываем список записей и проверяем, что
      // запись реально появилась в нужное время — ЕМИАС иногда отвечает «готово», но записи нет.
      const verify = await verifyAppointment(t, cand, ctx);
      if (verify.verifyFailed) {
        return {
          ok: true, verified: false, verifyFailed: true,
          message: 'Не удалось проверить результат: ЕМИАС не отдал список записей. Проверю на следующей проверке.',
          action: null,
        };
      }
      if (!verify.found) {
        return { ok: true, verified: false, message: 'ЕМИАС ответил «готово», но в списке записей я этого не вижу — проверьте вручную', action: null };
      }
      return { ok: true, verified: true, message: 'Готово', newAppointment: verify.found, action: null };
    }

    return { search, act, validateCandidate, listDoctors, listAddresses };
  }

  const api = { createTargets };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

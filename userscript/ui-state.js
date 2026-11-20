// userscript/ui-state.js — чистая логика мастера настройки (без DOM)
(function (root) {
  'use strict';

  const KEY = 'emiasSlotHunter:config';
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  // Цели визита для направления к врачу с needPurpose: true — сняты с сайта
  // emias.info 2026-09-24 (см. capture-2026-09-24-referral-doctor.md), это
  // единственные два варианта, которые сайт реально предложил для направления
  // к эндокринологу. 'unwell' — вариант по умолчанию.
  const INQUIRY_PURPOSES = {
    unwell: { inquiryPurposeId: 61, inquiryPurposeCode: 251, title: 'Плохое самочувствие или боль' },
    documents: { inquiryPurposeId: 63, inquiryPurposeCode: 255, title: 'Оформление документов' },
  };

  function createUiState() {
    const human = (iso) => {
      if (!iso) return '';
      const d = iso.slice(0, 10).split('-');
      return `${Number(d[2])} ${MONTHS[Number(d[1]) - 1]}, ${iso.slice(11, 16)}`;
    };
    const stripCampus = (addr) => String(addr || '').replace(/,\s*к\.\s*\d+.*$/i, '').trim();
    const dayHuman = (ymd) => { const d = String(ymd).split('-'); return `${Number(d[2])} ${MONTHS[Number(d[1]) - 1]}`; };
    const hasCurrentAddress = (option) => !!(option.current && typeof option.address === 'string' && option.address.trim());

    function buildTarget(option, form) {
      // form.when — три взаимоисключающих варианта:
      //  - 'earlier': раньше текущей записи, день любой (onlyDay=null, anyTime=false);
      //  - 'sameDayEarlier': в тот же день, что текущая запись, но раньше неё
      //    (onlyDay = день текущей записи, anyTime=false; человек день не вводит);
      //  - 'onlyDay' (синоним 'anyTimeOnDay'): в выбранный человеком день, любое время
      //    (onlyDay = form.day, anyTime=true) — независимо от того, раньше или позже
      //    текущей записи выбранный день, иначе цель молча никогда ничего не находит.
      const currentDay = option.current ? String(option.current).slice(0, 10) : null;
      let onlyDay = null;
      let anyTime = false;
      if (form.when === 'sameDayEarlier') {
        onlyDay = currentDay;
      } else if (form.when === 'onlyDay' || form.when === 'anyTimeOnDay') {
        onlyDay = form.day || null;
        anyTime = true;
      }

      const deadline = option.deadline || null;
      // Искать за пределами срока действия направления бессмысленно — если человек
      // задал dateTo позже deadline (или deadline вообще не знал), обрезаем по deadline.
      const dateTo = onlyDay || !form.dateTo ? null : (deadline && deadline < form.dateTo ? deadline : form.dateTo);
      const sameDoctor = option.scenario === 'shiftDoctor' && form.sameDoctor === true;
      const source = sameDoctor && !option.source.availableResourceId && form.doctor
        ? { ...option.source, availableResourceId: form.doctor.id, doctorName: form.doctor.name }
        : option.source;

      return {
        id: option.id, scenario: option.scenario, title: option.title, source,
        sameDoctor,
        current: option.current || null,
        onlyDay,
        anyTime,
        dateFrom: !onlyDay && form.dateFrom ? form.dateFrom : null,
        dateTo,
        deadline,
        timeFrom: form.timeFrom || null,
        timeTo: form.timeTo || null,
        addressContains: form.where === 'sameCampus' && hasCurrentAddress(option) ? stripCampus(option.address)
          : form.where === 'contains' ? (form.addressContains?.trim() || null) : null,
        exactAddresses: form.where === 'choose' ? [...new Set(form.selectedAddresses || [])] : [],
        prefer: form.preferUntil ? { until: form.preferUntil, timeTo: form.preferTimeTo || null } : null,
        near: form.nearStart && form.nearEnd ? { start: form.nearStart, end: form.nearEnd } : null,
        respectTravel: form.respectTravel !== false,
        travelMs: 60 * 60000,
        minLeadMs: 2 * 60 * 60000,
        keepImproving: form.keepImproving === true && !anyTime && option.scenario !== 'bookReferral',
        mode: form.mode === 'auto' ? 'auto' : 'confirm',
        purpose: (option.source && option.source.needPurpose) ? (() => {
          const chosen = INQUIRY_PURPOSES[form.purpose === 'documents' ? 'documents' : 'unwell'];
          return { inquiryPurposeId: chosen.inquiryPurposeId, inquiryPurposeCode: chosen.inquiryPurposeCode };
        })() : null,
      };
    }

    function purposeTitle(purpose) {
      const found = Object.values(INQUIRY_PURPOSES).find((p) => p.inquiryPurposeId === purpose.inquiryPurposeId);
      return found ? found.title : 'выбрана';
    }

    function describeTarget(t) {
      const parts = [];
      if (t.near) parts.push(`подгоняю ближе к ${human(t.near.start)}–${String(t.near.end).slice(11, 16)}`);
      else if (t.onlyDay && t.anyTime) parts.push(`только ${dayHuman(t.onlyDay)}`);
      else if (t.onlyDay && t.current) parts.push(`${dayHuman(t.onlyDay)}, раньше ${human(t.current)}`);
      else if (t.onlyDay) parts.push(`только ${dayHuman(t.onlyDay)}`);
      else if (t.current) parts.push(`раньше ${human(t.current)}`);

      // Если день не зафиксирован onlyDay, называем период поиска — иначе цель
      // без текущей записи (запись по направлению) не говорит о датах ничего.
      // Для bookDoctor и bookLdp дата уже называется в head ниже («…по направлению до …»).
      const byReferral = t.scenario === 'bookDoctor' || t.scenario === 'bookLdp';
      if (!t.onlyDay && !byReferral) {
        const last = t.dateTo || t.deadline || null;
        if (t.dateFrom && last) parts.push(`с ${dayHuman(t.dateFrom)} по ${dayHuman(last)}`);
        else if (t.dateFrom) parts.push(`с ${dayHuman(t.dateFrom)}`);
        else if (last) parts.push(`по ${dayHuman(last)}`);
        else if (!t.current && !t.near) parts.push('в ближайшие дни');
      }

      if (t.timeFrom || t.timeTo) parts.push(`время с ${t.timeFrom || '00:00'} до ${t.timeTo || '23:59'}`);
      const addresses = t.exactAddresses?.length ? t.exactAddresses : t.addressExact ? [t.addressExact] : [];
      if (addresses.length) parts.push(addresses.length === 1 ? `точный адрес — ${addresses[0]}`
        : `любой из выбранных адресов — ${addresses.join(' · ')}`);
      else if (t.addressContains) parts.push(`адрес содержит «${t.addressContains}»`);
      if (t.scenario === 'shiftDoctor') {
        const doctor = t.source?.doctorName || 'врач из текущей записи';
        parts.push(t.sameDoctor ? `только ${doctor}` : 'любой врач из предложенных ЕМИАС');
      }
      if (t.prefer) {
        let preferText = `сначала предпочитаю до ${dayHuman(t.prefer.until)}`;
        if (t.prefer.timeTo) preferText += `, до ${t.prefer.timeTo}`;
        parts.push(preferText);
      }
      if (t.purpose) parts.push(`цель визита: ${purposeTitle(t.purpose)}`);
      if (t.respectTravel) parts.push('час на дорогу между адресами');
      parts.push(t.mode === 'confirm' ? 'спрашиваю перед записью' : 'записываю сразу');
      parts.push(t.keepImproving ? 'продолжаю искать после успеха' : 'останавливаюсь после первого успеха');

      // bookDoctor и bookLdp — запись по направлению без текущей записи, для неё
      // отдельная формулировка «Запишу к <специальность> / на <исследование> по
      // направлению до <дата>» вместо общего «<title>: …» — дата уже учтена в head.
      if (byReferral) {
        const last = t.onlyDay ? null : t.dateTo || t.deadline;
        const first = t.onlyDay ? null : t.dateFrom;
        const range = first ? ` с ${dayHuman(first)}` + (last ? ` по ${dayHuman(last)}` : '')
          : last ? ` до ${dayHuman(last)}` : '';
        const head = `Запишу ${t.scenario === 'bookLdp' ? 'на' : 'к'} ${t.title} по направлению` + range;
        return parts.length ? `${head}, ${parts.join(', ')}` : head;
      }

      return `${t.title}: ${parts.join(', ')}`;
    }

    function describeDryRunItem(item) {
      const head = item.waiting
        ? `${item.title}: подходящих слотов сейчас нет, жду`
        : item.would ? [`${item.title}: взяла бы ${human(item.would.startTime)}`, item.would.doctorName, item.would.address].filter(Boolean).join(' — ') : item.title;
      const warn = (item.warnings || []).map((w) => `\n  ⚠ ${w}`).join('');
      const notes = (item.notes || []).map((n) => `\n  · ${n}`).join('');
      return head + warn + notes;
    }

    const saveConfig = (storage, cfg) => storage.setItem(KEY, JSON.stringify(cfg));
    const loadConfig = (storage) => { try { return JSON.parse(storage.getItem(KEY)) || null; } catch (e) { return null; } };

    // Интерфейс хранит отдельный снимок целей для панели состояния.
    function applyBookedUpdate(cfg, payload) {
      if (!cfg || !Array.isArray(cfg.targets) || !payload || payload.targetId == null) return cfg;
      let changed = false;
      const targets = cfg.targets.map((t) => {
        if (t.id !== payload.targetId) return t;
        changed = true;
        return { ...t, current: payload.current, source: payload.source, scenario: payload.scenario };
      });
      return changed ? { ...cfg, targets } : cfg;
    }

    return {
      buildTarget, describeTarget, describeDryRunItem, saveConfig, loadConfig, applyBookedUpdate, human, stripCampus, hasCurrentAddress, KEY,
      INQUIRY_PURPOSES,
    };
  }

  const api = { createUiState };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

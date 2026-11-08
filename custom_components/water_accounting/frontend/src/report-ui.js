/* Report and settings UI; mounted once, telemetry is patched in place. */
const WaterReportUI = {
  _initAccountUI() {
    this._accountSettings = null;
    this._settingsTrusted = false;
    this._settingsAttempted = false;
    this._settingsPromise = null;
    this._settingsToken = 0;
    this._settingsTimer = null;
    this._settingsDraft = null;
    this._settingsDraftRevision = null;
    this._settingsDirty = false;
    this._settingsSaving = false;
    this._settingsConflict = false;
    this._settingsError = '';
    this._settingsNotice = '';
    this._reportLoad = null;
    this._reportToken = 0;
  },

  _disconnectAccountUI() {
    this._settingsToken++;
    this._reportToken++;
    if (this._settingsTimer !== null) window.clearTimeout(this._settingsTimer);
    this._settingsTimer = null;
    this._settingsPromise = null;
    this._settingsTrusted = false;
    this._settingsAttempted = false;
    this._reportLoad = null;
  },

  _isAccountAdmin() {
    return this._hass?.user?.is_admin === true;
  },

  _isIrrigationRole(role) {
    return role === 'pressure_irrigation' || role.startsWith('irrigation_');
  },

  _irrigationInactive() {
    return this._settingsTrusted && this._accountSettings?.settings.irrigation.enabled === false;
  },

  _irrigationNote() {
    const irrigation = this._accountSettings?.settings.irrigation;
    return this._irrigationInactive()
      ? 'Полив отключён: ' + irrigation.reason + ' · с ' + this._reportDate(irrigation.since)
      : '';
  },

  _validSettingsSnapshot(value) {
    const s = value?.settings;
    const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
      && Number.isFinite(Date.parse(d + 'T00:00:00Z'))
      && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
    return Number.isInteger(value?.revision) && value.revision >= 0 && s
      && validDate(s.statistics_start_date) && Number.isFinite(s.low_day_threshold_l)
      && s.low_day_threshold_l >= 0 && s.low_day_threshold_l <= 10000
      && (s.regeneration_verified_from === null || validDate(s.regeneration_verified_from))
      && (s.regeneration_verified_through === null || validDate(s.regeneration_verified_through))
      && s.irrigation && typeof s.irrigation.enabled === 'boolean'
      && typeof s.irrigation.reason === 'string' && s.irrigation.reason.length <= 500
      && (s.irrigation.enabled || (s.irrigation.reason.trim() && validDate(s.irrigation.since)));
  },

  _acceptSettingsSnapshot(snapshot) {
    if (!this._validSettingsSnapshot(snapshot)) throw new Error('Некорректный ответ настроек');
    this._accountSettings = JSON.parse(JSON.stringify(snapshot));
    this._settingsTrusted = true;
    this._settingsError = '';
    if (!this._settingsDirty) {
      this._settingsDraft = JSON.parse(JSON.stringify(snapshot.settings));
      this._settingsDraftRevision = snapshot.revision;
    }
  },

  _accountError(error) {
    return ({revision_conflict: 'Настройки изменены в другом окне. Черновик сохранён на экране. Загрузите сохранённые настройки и повторите изменение.',
      unauthorized: 'Изменять настройки может администратор Home Assistant.',
      storage_error: 'Не удалось прочитать или сохранить настройки. Отключение полива не подтверждено.',
      not_loaded: 'Интеграция «Учёт воды» не загружена.',
      unknown_command: 'Обновите интеграцию «Учёт воды», чтобы использовать настройки.',
    })[error?.code] || (error?.code === 'invalid_settings' ? error.message : 'Не удалось получить подтверждение Home Assistant. Повторите запрос.');
  },

  _scheduleAccountSettings() {
    if (this._settingsTimer !== null) window.clearTimeout(this._settingsTimer);
    this._settingsTimer = null;
    if (this.isConnected) this._settingsTimer = window.setTimeout(() => {
      this._settingsTimer = null;
      this._loadAccountSettings(true);
    }, 60000);
  },

  async _loadAccountSettings(force = false, afterSave = false) {
    if (!this._hass || typeof this._hass.callWS !== 'function') return null;
    if (this._settingsSaving && !afterSave) return this._settingsTrusted ? this._accountSettings : null;
    if (this._settingsPromise) return this._settingsPromise;
    if (this._settingsAttempted && !force) return this._settingsTrusted ? this._accountSettings : null;
    this._settingsAttempted = true;
    const token = ++this._settingsToken;
    this._settingsPromise = (async () => {
      await Promise.resolve();
      try {
        const result = await this._withTimeout(this._hass.callWS({type: 'water_accounting/settings', action: 'get'}), 15000);
        if (token !== this._settingsToken) return null;
        this._acceptSettingsSnapshot(result);
        return this._accountSettings;
      } catch (error) {
        if (token === this._settingsToken) {
          this._settingsTrusted = false;
          this._settingsError = this._accountError(error);
        }
        return null;
      } finally {
        if (token === this._settingsToken) {
          this._settingsPromise = null;
          this._queuePatch();
          this._scheduleAccountSettings();
        }
      }
    })();
    this._queuePatch();
    return this._settingsPromise;
  },

  _bindAccountEvents() {
    const edit = event => {
      const node = event.target;
      if (!node?.dataset?.setting || !this._settingsDraft || !this._isAccountAdmin() || this._settingsSaving) return;
      const path = node.dataset.setting.split('.');
      const target = path.length === 2 ? this._settingsDraft[path[0]] : this._settingsDraft;
      const key = path[path.length - 1];
      target[key] = node.type === 'checkbox' ? node.checked : node.type === 'number'
        ? (node.value === '' ? null : Number(node.value)) : (node.value || (node.type === 'date' ? null : ''));
      this._settingsDirty = true;
      this._settingsNotice = '';
      this._patchAccountSettings();
    };
    this.shadowRoot.addEventListener('input', edit);
    this.shadowRoot.addEventListener('change', edit);
    this.shadowRoot.addEventListener('click', event => {
      const action = event.target?.closest?.('[data-settings-action]')?.dataset.settingsAction;
      if (action === 'save') this._saveAccountSettings();
      if (action === 'reload') this._reloadAccountDraft();
    });
    this.shadowRoot.addEventListener('submit', event => {
      if (event.target.matches('.account-settings-form')) {
        event.preventDefault();
        this._saveAccountSettings();
      }
    });
  },

  async _reloadAccountDraft() {
    if (this._settingsSaving) return;
    // Discard only after a successful read; a failed reload must not lose the draft.
    const current = await this._loadAccountSettings(true);
    if (current) {
      this._settingsDirty = false;
      this._settingsConflict = false;
      this._settingsDraft = JSON.parse(JSON.stringify(current.settings));
      this._settingsDraftRevision = current.revision;
      this._settingsNotice = 'Загружены сохранённые настройки.';
      this._queuePatch();
    }
  },

  async _saveAccountSettings() {
    if (this._settingsSaving || this._settingsPromise || this._settingsConflict || !this._settingsDirty || !this._settingsTrusted || !this._isAccountAdmin()) return false;
    const form = this._views.get('settings')?.querySelector('form');
    if (form && !form.reportValidity()) return false;
    const token = this._settingsToken;
    const payload = JSON.parse(JSON.stringify(this._settingsDraft));
    this._settingsSaving = true;
    this._settingsNotice = '';
    this._queuePatch();
    try {
      const result = await this._withTimeout(this._hass.callWS({type: 'water_accounting/settings',
        action: 'update', revision: this._settingsDraftRevision, payload}), 15000);
      if (token !== this._settingsToken) return false;
      this._acceptSettingsSnapshot(result);
      this._settingsDirty = false;
      this._settingsDraft = JSON.parse(JSON.stringify(result.settings));
      this._settingsDraftRevision = result.revision;
      this._settingsNotice = 'Настройки сохранены.';
      this._reportToken++;
      this._reportLoad = null;
      return true;
    } catch (error) {
      this._settingsNotice = this._accountError(error);
      if (error?.code === 'revision_conflict') this._settingsConflict = true;
      // A timeout/write error can leave the outcome uncertain. Re-read authoritative state.
      this._settingsTrusted = false;
      await this._loadAccountSettings(true, true);
      return false;
    } finally {
      this._settingsSaving = false;
      this._scheduleAccountSettings();
      this._queuePatch();
    }
  },

  _settingsMarkup() {
    return '<article class="card page-heading"><p class="eyebrow">Параметры учёта</p><h1>Настройки</h1>'
      + '<p>Сохраняются в Home Assistant и действуют на всех устройствах.</p></article>'
      + '<p class="account-notice" data-settings-status role="status" aria-live="polite">Загрузка настроек…</p>'
      + '<form class="account-settings-form">'
      + '<article class="card settings-card"><h2>Линия полива</h2><p data-irrigation-saved></p>'
      + '<label class="setting-switch"><input id="irrigation-enabled" type="checkbox" data-setting="irrigation.enabled">'
      + '<span>Линия полива включена</span></label>'
      + '<p class="field-help">Если линия отключена на зиму, для обслуживания или по другой причине, снимите отметку. Её давление и недоступность датчиков не будут считаться проблемой.</p>'
      + '<div class="settings-grid"><label>Причина отключения<input id="irrigation-reason" type="text" maxlength="500" list="irrigation-reasons" data-setting="irrigation.reason" placeholder="Например, на зиму"></label>'
      + '<label>Отключена с<input id="irrigation-since" type="date" min="2015-01-01" data-setting="irrigation.since"></label></div>'
      + '<datalist id="irrigation-reasons"><option value="На зиму"></option><option value="Обслуживание"></option><option value="Ремонт"></option></datalist>'
      + '<p class="field-help">Это отметка состояния. Она не управляет краном и не изменяет историю расхода. После включения обычные проверки возобновятся.</p></article>'
      + '<article class="card settings-card"><h2>Статистика питьевой воды</h2><div class="settings-grid">'
      + '<label>Начало накопительной выборки<input id="stat-start" type="date" min="2015-01-01" required data-setting="statistics_start_date"></label>'
      + '<label>Порог низкого расхода, л/сут<input id="stat-low" type="number" min="0" max="10000" step="any" required data-setting="low_day_threshold_l"></label></div>'
      + '<p class="field-help">Предварительный порог — 100 л/сут. Нулевые дни и дни ниже порога после вычета учтённых регенераций исключаются из характерного среднего. Месячный расход включает все дни.</p>'
      + '<details class="verification-settings"><summary>Подтверждение журнала регенераций</summary>'
      + '<p class="field-help">Укажите период, только если проверены все циклы и их измеренные объёмы в «Водоподготовке». За его пределами результат подписан «По учтённым циклам», а не «Чистый расход».</p>'
      + '<div class="settings-grid"><label>Проверено с<input id="regen-verified-from" type="date" min="2015-01-01" data-setting="regeneration_verified_from"></label>'
      + '<label>Проверено по<input id="regen-verified-through" type="date" min="2015-01-01" data-setting="regeneration_verified_through"></label></div></details></article>'
      + '<div class="settings-actions"><button class="account-button primary" type="submit" data-settings-save>Сохранить</button>'
      + '<button class="account-button" type="button" data-settings-action="reload">Загрузить сохранённые</button></div>'
      + '<p class="field-help">«Загрузить сохранённые» заменяет несохранённый черновик после успешной загрузки.</p></form>';
  },

  _patchAccountSettings() {
    const root = this._views.get('settings');
    if (!root) return;
    const editable = this._isAccountAdmin() && this._settingsTrusted && !this._settingsSaving && !this._settingsPromise;
    const status = this._settingsError || this._settingsNotice || (!this._settingsAttempted || this._settingsPromise ? 'Загрузка настроек…'
      : !this._isAccountAdmin() ? 'Просмотр настроек. Для изменения нужны права администратора Home Assistant.'
      : this._settingsDirty ? 'Есть несохранённые изменения.' : 'Настройки загружены.');
    this._setText('[data-settings-status]', status, root);
    this._setText('[data-irrigation-saved]', this._settingsTrusted
      ? (this._irrigationInactive() ? this._irrigationNote() : 'Сохранённое состояние: включена. Давление и датчики проверяются.')
      : 'Сохранённое состояние не подтверждено. Обычные проверки действуют.', root);
    root.querySelectorAll('[data-setting]').forEach(node => {
      const path = node.dataset.setting.split('.');
      const value = path.reduce((item, key) => item?.[key], this._settingsDraft);
      const isReason = path[0] === 'irrigation' && path[1] !== 'enabled';
      node.disabled = !editable || (isReason && this._settingsDraft?.irrigation.enabled !== false);
      if (node.type === 'checkbox') node.checked = value === true;
      else if (this.shadowRoot.activeElement !== node && node.value !== String(value ?? '')) node.value = value ?? '';
      if (node.type === 'date') node.max = WaterReportModel.periods(Date.now()).today;
      if (isReason) node.required = this._settingsDraft?.irrigation.enabled === false;
    });
    const save = root.querySelector('[data-settings-save]');
    if (save) {
      save.disabled = !editable || !this._settingsDirty || this._settingsConflict;
      save.textContent = this._settingsSaving ? 'Сохранение…' : 'Сохранить';
    }
    const reload = root.querySelector('[data-settings-action="reload"]');
    if (reload) reload.disabled = this._settingsSaving || !!this._settingsPromise;
  },

  _statisticsReportMarkup() {
    return '<article class="card page-heading"><p class="eyebrow">По правилам еженедельной сводки</p><h1>Статистика воды</h1>'
      + '<p>Питьевая вода · завершённые сутки · Europe/Moscow</p></article>'
      + '<p class="account-notice" data-report-status role="status" aria-live="polite">Загрузка отчёта…</p>'
      + '<div class="water-report" data-report-content></div>';
  },

  _reportKey(settings) {
    const {irrigation, ...parameters} = settings;
    return JSON.stringify([this._config().entities.drinking_total, WaterReportModel.periods(Date.now(), settings).today, parameters]);
  },

  async _loadWaterReport(force = false) {
    const settings = await this._loadAccountSettings();
    if (!settings) { this._queuePatch(); return null; }
    let key, period;
    try {
      key = this._reportKey(settings.settings);
      period = WaterReportModel.periods(Date.now(), settings.settings);
    } catch (error) {
      this._reportLoad = {status: 'error', error: error.message};
      this._queuePatch();
      return this._reportLoad;
    }
    const previous = this._reportLoad;
    if (previous?.key === key && (previous.status === 'loading' || (!force && Date.now() - previous.loadedAt < 300000))) return previous.promise || previous;
    const token = ++this._reportToken;
    const load = {key, status: 'loading', loadedAt: Date.now()};
    this._reportLoad = load;
    const entity = this._config().entities.drinking_total;
    const now = Date.now();
    load.promise = (async () => {
      try {
        const results = await Promise.allSettled([
          this._statsPool.run(() => this._withTimeout(this._hass.callWS({type: 'recorder/statistics_during_period',
            statistic_ids: [entity], start_time: new Date(period.requestStart - 3600000).toISOString(),
            end_time: new Date(period.requestEnd).toISOString(), period: 'hour', types: ['change', 'sum'], units: {volume: 'm³'}}), 60000)),
          this._statsPool.run(() => this._withTimeout(this._hass.callWS({type: 'water_treatment/filters', action: 'get'}), 15000)),
        ]);
        if (token !== this._reportToken) return null;
        if (results[0].status !== 'fulfilled' || !Array.isArray(results[0].value?.[entity])) throw new Error('Recorder недоступен или не вернул статистику счётчика.');
        const journal = results[1];
        load.result = WaterReportModel.build({now, settings: settings.settings, rows: results[0].value[entity],
          treatment: journal.status === 'fulfilled' ? journal.value : null, treatmentAvailable: journal.status === 'fulfilled', unit: 'm³'});
        load.status = 'complete';
        load.loadedAt = Date.now();
        return load;
      } catch (error) {
        if (token === this._reportToken) { load.status = 'error'; load.error = error.message || 'Не удалось рассчитать отчёт.'; }
        return load;
      } finally {
        if (token === this._reportToken) this._queuePatch();
      }
    })();
    this._queuePatch();
    return load.promise;
  },

  _reportDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value.slice(8, 10) + '.' + value.slice(5, 7) + '.' + value.slice(0, 4) : '—';
  },

  _reportMetric(label, value, unit, digits = 1) {
    return '<div class="report-metric"><span>' + escapeHtml(label) + '</span><strong>'
      + (Number.isFinite(value) ? escapeHtml(this._formatNumber(value, digits)) : '—')
      + '<small>' + escapeHtml(unit) + '</small></strong></div>';
  },

  _reportMarkup(report) {
    const typical = report.typical, all = typical.groups.all;
    const netLabel = typical.net_verified ? 'Чистый расход' : 'По учтённым циклам';
    const range = this._reportDate(typical.start) + ' — ' + this._reportDate(typical.end);
    let html = '<article class="card report-summary"><p class="eyebrow">Характерный среднесуточный расход</p>'
      + '<h2>' + (typical.calendar_days ? range : 'Нет завершённых суток') + '</h2><div class="report-metrics">'
      + this._reportMetric(netLabel, typical.net_verified ? all.net_lpd : all.adjusted_lpd, 'л/сут')
      + this._reportMetric('Общий расход', all.gross_lpd, 'л/сут') + '</div>'
      + '<p class="field-help">Учтено дней: ' + typical.included_days + ' из ' + typical.calendar_days
      + '. Исключено: ' + typical.excluded_days + '. Порог: ' + escapeHtml(this._formatNumber(typical.threshold_l, 0)) + ' л/сут.</p></article>';
    if (report.warnings.length) html += '<aside class="card report-warning"><h2>Полнота данных</h2><ul>'
      + report.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul></aside>';
    html += '<article class="card report-groups"><h2>Рабочие, выходные и праздники</h2><p class="field-help">Календарь РФ, пятидневная рабочая неделя. Среднее взвешено по числу учтённых дней.</p>';
    [['workday', 'Рабочие дни'], ['weekend', 'Выходные дни'], ['holiday', 'Праздничные дни'], ['nonworking', 'Все нерабочие дни']].forEach(([key, title]) => {
      const group = typical.groups[key];
      const exact = Number.isFinite(group.net_lpd);
      html += '<section class="report-group"><div class="report-group-heading"><h3>' + title + '</h3><span>Дней: ' + group.days + '</span></div><div class="report-metrics">'
        + this._reportMetric(exact ? 'Чистый' : 'По учтённым циклам', exact ? group.net_lpd : group.adjusted_lpd, 'л/сут')
        + this._reportMetric('Общий', group.gross_lpd, 'л/сут') + '</div></section>';
    });
    html += '</article><section class="report-months">';
    report.months.forEach(month => {
      const exact = Number.isFinite(month.net_m3);
      html += '<article class="card report-month"><p class="eyebrow">' + (month.key === 'current' ? 'Текущий месяц' : 'Предыдущий месяц') + '</p>'
        + '<h2>' + escapeHtml(new Intl.DateTimeFormat('ru', {month: 'long', year: 'numeric', timeZone: 'Europe/Moscow'}).format(new Date(month.start + 'T12:00:00+03:00'))) + '</h2>'
        + '<p class="field-help">' + (month.expected_days ? this._reportDate(month.start) + ' — ' + this._reportDate(month.end) : 'Ещё нет завершённых суток')
        + ' · полных дней ' + month.complete_days + '/' + month.expected_days + '</p><div class="report-metrics">'
        + this._reportMetric(exact ? 'Чистый расход' : 'По учтённым циклам', exact ? month.net_m3 : month.adjusted_m3, 'м³', 3)
        + this._reportMetric('Общий расход', month.gross_m3, 'м³', 3)
        + this._reportMetric(exact ? 'Чистый в сутки' : 'По циклам в сутки', exact ? month.net_lpd : month.adjusted_lpd, 'л/сут')
        + this._reportMetric('Общий в сутки', month.gross_lpd, 'л/сут') + '</div>'
        + '<p class="field-help">Учтённые регенерации: ' + this._formatNumber(month.regeneration_m3, 3) + ' м³ · циклов: ' + month.cycles
        + (month.unknown_cycles ? ' · без подтверждённого объёма: ' + month.unknown_cycles : '') + '.</p>'
        + (!exact ? '<p class="report-caveat">Чистый расход не установлен: требуется полная история и подтверждённый журнал.</p>' : '')
        + (month.status === 'partial' ? '<p class="report-caveat">Данные неполные. Известный объём: ' + this._formatNumber(month.known_gross_m3, 3) + ' м³; это не итог месяца.</p>' : '')
        + '<p class="field-help">Все календарные дни, включая отсутствие. Фактический расход, без прогноза.</p></article>';
    });
    html += '</section><article class="card"><h2>Регенерации за период выборки</h2><div class="report-metrics">'
      + this._reportMetric('Учтённый технологический расход', report.regenerations.volume_m3, 'м³', 3)
      + this._reportMetric('Измеренных циклов', report.regenerations.cycles, '', 0) + '</div>'
      + '<p class="field-help">Источник: журнал «Водоподготовки». Время цикла не восстановлено; показана записанная дата. Оценочные объёмы не вычитаются.</p>';
    if (report.regenerations.events.length) html += '<ul class="report-events">' + report.regenerations.events.map(event => '<li><span>' + this._reportDate(event.date)
      + '</span><strong>' + (Number.isFinite(event.volume_m3) ? this._formatNumber(event.volume_m3 * 1000, 1) + ' л'
        : event.status === 'ambiguous' ? 'Неоднозначная запись' : 'Объём не подтверждён') + '</strong></li>').join('') + '</ul>';
    else html += '<p class="field-help">' + (report.regenerations.available ? 'В журнале нет циклов за этот период. Полнота определяется проверенным интервалом.' : 'Журнал недоступен.') + '</p>';
    report.regenerations.issues.forEach(issue => { html += '<p class="report-caveat">' + escapeHtml(issue) + '</p>'; });
    html += '</article><article class="card"><h2>Изменение к прошлому понедельнику</h2>';
    if (report.comparison.available) {
      const change = report.comparison.delta_all;
      const signed = value => Number.isFinite(value) ? (value > 0 ? '+' : '') + this._formatNumber(value, 1) + ' л/сут' : '—';
      html += '<p>Общее среднее: <strong>' + signed(change.gross_lpd) + '</strong>. '
        + (Number.isFinite(change.net_lpd) ? 'Чистое: <strong>' + signed(change.net_lpd) : 'По учтённым циклам: <strong>' + signed(change.adjusted_lpd)) + '</strong>.</p>';
    } else html += '<p class="field-help">Пока недостаточно завершённых дней для сравнения.</p>';
    html += '<p class="field-help">Расчёт на границу ' + this._reportDate(report.comparison.as_of) + ' по текущей истории и текущим настройкам. Это реконструкция, а не сохранённый прошлый отчёт.</p></article>';
    const reasons = {missing_data: 'неполная история счётчика', regeneration_unknown: 'неизвестен объём регенераций',
      regeneration_exceeds_total: 'регенерация превышает суточный расход', low_consumption: 'нулевой расход или ниже порога'};
    html += '<details class="card report-details"><summary>Методика и исключённые дни (' + typical.excluded_days + ')</summary>'
      + '<p class="field-help">Источник расхода: ' + escapeHtml(this._config().entities.drinking_total) + '. Часовая статистика Recorder, объёмы м³. Полные сутки: 00:00–24:00 Europe/Moscow. Текущий день исключён. Пропуски не заменяются нулём.</p>'
      + '<p class="field-help">Чистый расход = общий − измеренные регенерации, если подтверждены все циклы. Нулевые дни и дни ниже порога исключаются только из характерного среднего; месячные суммы и средние включают все календарные дни.</p>'
      + '<ul>' + typical.excluded.map(day => '<li>' + this._reportDate(day.date) + ': ' + escapeHtml(reasons[day.reason] || day.reason) + '</li>').join('') + '</ul></details>';
    return html;
  },

  _patchWaterReport() {
    const root = this._views.get('statistics');
    if (!root) return;
    const load = this._reportLoad;
    const host = root.querySelector('[data-report-content]');
    let current = false;
    try { current = this._settingsTrusted && load?.key === this._reportKey(this._accountSettings.settings); } catch (_error) { /* Error shown below. */ }
    const ready = current && load?.status === 'complete';
    this._setText('[data-report-status]', this._settingsError || (load?.status === 'error' ? load.error : !current || !load || load.status === 'loading'
      ? 'Загрузка отчёта…'
        : 'Рассчитано: ' + this._formatDateTime(load.result.generated_at) + ' · Europe/Moscow'), root);
    if (host) {
      host.hidden = !ready;
      if (ready && host._reportResult !== load.result) {
        const open = Array.from(host.querySelectorAll('details')).map(item => item.open);
        host.innerHTML = this._reportMarkup(load.result);
        host.querySelectorAll('details').forEach((item, index) => { item.open = open[index] || false; });
        host._reportResult = load.result;
      }
    }
  },
};

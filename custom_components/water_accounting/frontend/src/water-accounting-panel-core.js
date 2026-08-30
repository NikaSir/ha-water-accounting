/* NikaS Water Accounting panel — autonomous Home Assistant frontend core. */

const WATER_APP = Object.freeze({
  title: "Учёт воды",
  uiVersion: "0.1.0",
  preferredView: "overview",
  safeReturnRoute: "/dashboard-house-v11/home",
  tabs: [
    ["overview", "mdi:water-outline", "Обзор"],
    ["consumption", "mdi:chart-bar", "Расход"],
    ["meters", "mdi:gauge", "Счётчики"],
    ["diagnostics", "mdi:stethoscope", "Диагн."],
  ],
  entities: Object.freeze({
    pressure_drinking: "sensor.nikas_h2000_pro_pitevaia_voda",
    pressure_irrigation: "sensor.nikas_h2000_pro_voda_na_poliv_2",
    zont_online: "binary_sensor.nikas_h2000_pro_online",
    drinking_total: "sensor.schetchik_vody_svd_20_0020989_pokazaniia",
    drinking_temperature: "sensor.schetchik_vody_svd_20_0020989_temperatura",
    drinking_battery: "sensor.schetchik_vody_svd_20_0020989_batareia",
    drinking_signal: "sensor.schetchik_vody_svd_20_0020989_signal",
    drinking_updated: "sensor.schetchik_vody_svd_20_0020989_obnovleno",
    irrigation_total: "sensor.schetchik_vody_svd_20_0020988_pokazaniia",
    irrigation_temperature: "sensor.schetchik_vody_svd_20_0020988_temperatura",
    irrigation_battery: "sensor.schetchik_vody_svd_20_0020988_batareia",
    irrigation_signal: "sensor.schetchik_vody_svd_20_0020988_signal",
    irrigation_updated: "sensor.schetchik_vody_svd_20_0020988_obnovleno",
  }),
  pressurePolicy: Object.freeze({
    drinking: Object.freeze({ normalMin: 2.4, normalMax: 3.1 }),
    irrigation: Object.freeze({
      criticalLowBelow: 0.3,
      normalMin: 2.5,
      normalMax: 3.5,
      warningHighMax: 4.0,
    }),
  }),
});

const WATER_CSS = "__WATER_ACCOUNTING_CSS__";
const SOURCE_ROUTE_KEY = "nikas.specialized.source_route.v1";
const SOURCE_ROUTE_AT_KEY = "nikas.specialized.source_route_at.v1";
const RETURN_ROUTE_KEY = "nikas.water-accounting.return_route.v1";
const SOURCE_ROUTE_TTL_MS = 30_000;
const VIEW_STORAGE_KEY = "nikas.water-accounting.view.v1";
const PERIOD_STORAGE_KEY = "nikas.water-accounting.period.v1";
const VALID_VIEWS = new Set(WATER_APP.tabs.map(function (tab) { return tab[0]; }));
const VALID_PERIODS = new Set(["24h", "7d", "30d", "12m"]);
const BAD_STATES = new Set(["", "unknown", "unavailable", "none", "null"]);

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function canonicalBaseRoute(pathname) {
  if (pathname === "/dashboard-house-v11" || pathname.startsWith("/dashboard-house-v11/")) {
    return "/dashboard-house-v11/home";
  }
  if (pathname === "/dashboard-actions" || pathname.startsWith("/dashboard-actions/")) {
    return "/dashboard-actions/home";
  }
  if (pathname === "/dashboard-infrastructure" || pathname.startsWith("/dashboard-infrastructure/")) {
    return "/dashboard-infrastructure/overview";
  }
  return null;
}

function safeReturnRoute(value) {
  if (!value) return null;
  try {
    const url = new URL(decodeURIComponent(String(value).trim()), window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return canonicalBaseRoute(url.pathname);
  } catch (_error) {
    return null;
  }
}

function resolveReturnRoute(panel) {
  const current = new URL(window.location.href);
  const explicit = safeReturnRoute(current.searchParams.get("return_to"))
    || safeReturnRoute(current.searchParams.get("from"));
  let handedOff = null;
  let saved = null;
  try {
    const rawRoute = sessionStorage.getItem(SOURCE_ROUTE_KEY);
    const rawAt = sessionStorage.getItem(SOURCE_ROUTE_AT_KEY);
    sessionStorage.removeItem(SOURCE_ROUTE_KEY);
    sessionStorage.removeItem(SOURCE_ROUTE_AT_KEY);
    if (rawRoute !== null && rawAt !== null) {
      const at = Number(rawAt);
      const age = Date.now() - at;
      if (Number.isFinite(at) && age >= 0 && age <= SOURCE_ROUTE_TTL_MS) {
        handedOff = safeReturnRoute(rawRoute);
      }
    }
    saved = safeReturnRoute(sessionStorage.getItem(RETURN_ROUTE_KEY));
  } catch (_error) {
    // Session persistence is optional.
  }
  const configured = safeReturnRoute(panel._panel && panel._panel.config
    ? panel._panel.config.parent_route
    : null);
  const route = explicit
    || handedOff
    || saved
    || safeReturnRoute(document.referrer)
    || configured
    || WATER_APP.safeReturnRoute;
  try {
    sessionStorage.setItem(RETURN_ROUTE_KEY, route);
  } catch (_error) {
    // Session persistence is optional.
  }
  return route;
}

function navigateToSource(panel) {
  const route = safeReturnRoute(panel._returnRoute) || WATER_APP.safeReturnRoute;
  window.history.pushState(null, "", route);
  window.dispatchEvent(new Event("location-changed"));
}

function numeric(value) {
  if (value == null || BAD_STATES.has(String(value).trim().toLowerCase())) return null;
  const result = Number(String(value).replace(",", "."));
  return Number.isFinite(result) ? result : null;
}

function loadStoredChoice(key, valid, fallback) {
  try {
    const value = localStorage.getItem(key);
    return valid.has(value) ? value : fallback;
  } catch (_error) {
    return fallback;
  }
}

function saveStoredChoice(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_error) {
    // Local persistence is optional.
  }
}

class WaterTaskPool {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task: task, resolve: resolve, reject: reject });
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.limit && this.queue.length) {
      const item = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this._drain();
        });
    }
  }
}

class NikaSWaterAccountingPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._panel = null;
    this._shellMounted = false;
    this._patchQueued = false;
    this._returnRoute = null;
    this._view = loadStoredChoice(VIEW_STORAGE_KEY, VALID_VIEWS, WATER_APP.preferredView);
    this._period = loadStoredChoice(PERIOD_STORAGE_KEY, VALID_PERIODS, "24h");
    this._views = new Map();
    this._statsLoads = new Map();
    this._statsPool = new WaterTaskPool(2);
    this._overviewStatsRequested = false;
    this._refreshing = false;
    this._hold = null;
    this._holdFiredUntil = 0;
  }

  set hass(value) {
    this._hass = value;
    this._queuePatch();
  }

  get hass() {
    return this._hass;
  }

  set panel(value) {
    this._panel = value;
    const preferred = value && value.config ? value.config.preferred_view : null;
    if (VALID_VIEWS.has(preferred) && !this._shellMounted) this._view = preferred;
    this._queuePatch();
  }

  get panel() {
    return this._panel;
  }

  connectedCallback() {
    this._mountShell();
    this._queuePatch();
  }

  _config() {
    const config = this._panel && this._panel.config ? this._panel.config : {};
    const tabs = Array.isArray(config.tabs) && config.tabs.length
      ? config.tabs.slice(0, 5)
      : WATER_APP.tabs;
    return {
      title: config.title || WATER_APP.title,
      uiVersion: /^\d+\.\d+\.\d+$/.test(String(config.ui_version || ""))
        ? String(config.ui_version)
        : WATER_APP.uiVersion,
      tabs: tabs,
      entities: Object.assign({}, WATER_APP.entities, config.entities || {}),
      pressurePolicy: Object.assign({}, WATER_APP.pressurePolicy, config.pressure_policy || {}),
    };
  }

  _mountShell() {
    if (this._shellMounted || !this.isConnected) return;
    this._returnRoute = resolveReturnRoute(this);
    const config = this._config();
    this.shadowRoot.innerHTML = '<style>' + WATER_CSS + '</style>'
      + '<div class="app-shell">'
      + '<header class="app-header">'
      + '<button type="button" class="header-action" id="menu" aria-label="Меню Home Assistant">'
      + '<ha-icon icon="mdi:menu"></ha-icon></button>'
      + '<button type="button" class="header-title" id="return-source" aria-label="Вернуться в базовую панель NikaS">'
      + '<strong>' + escapeHtml(config.title) + '</strong>'
      + '<span>UI v' + escapeHtml(config.uiVersion) + '</span></button>'
      + '<button type="button" class="header-action" id="refresh" aria-label="Обновить">'
      + '<ha-icon icon="mdi:refresh"></ha-icon></button>'
      + '</header>'
      + '<main class="canvas-viewport" aria-label="Рабочая область панели">'
      + '<div class="work-canvas"></div></main>'
      + '<nav class="tabbar" aria-label="Разделы"></nav>'
      + '<div class="scale-status" role="status" aria-live="polite">Масштаб 100%</div>'
      + '<div class="panel-toast" role="status" aria-live="polite"></div>'
      + '</div>';
    this._bindShellEvents();
    this._renderTabBar();
    this._activateView(this._view, false);
    this._shellMounted = true;
    window.requestAnimationFrame(() => {
      if (this.isConnected) {
        window.NikasPanelZoom && window.NikasPanelZoom.attach
          ? window.NikasPanelZoom.attach(this, { min: 0.75, max: 2.0 })
          : null;
      }
    });
  }

  _bindShellEvents() {
    this.shadowRoot.addEventListener("click", (event) => {
      const button = event.target && event.target.closest ? event.target.closest("button") : null;
      if (!button) return;
      if (Date.now() < this._holdFiredUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (button.id === "menu") {
        this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
      } else if (button.id === "return-source") {
        navigateToSource(this);
      } else if (button.id === "refresh") {
        this._refresh();
      } else if (button.dataset.view) {
        this._activateView(button.dataset.view, true);
      } else if (button.dataset.period) {
        this._selectPeriod(button.dataset.period);
      }
    });

    this.shadowRoot.addEventListener("pointerdown", (event) => this._beginHold(event));
    this.shadowRoot.addEventListener("pointermove", (event) => this._moveHold(event));
    ["pointerup", "pointercancel", "pointerleave"].forEach((name) => {
      this.shadowRoot.addEventListener(name, () => this._cancelHold());
    });
  }

  _beginHold(event) {
    const target = event.target && event.target.closest
      ? event.target.closest("[data-entity]")
      : null;
    if (!target || !target.dataset.entity) return;
    this._cancelHold();
    this._hold = {
      target: target,
      entityId: target.dataset.entity,
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        if (!this._hold) return;
        this._holdFiredUntil = Date.now() + 650;
        this.dispatchEvent(new CustomEvent("hass-more-info", {
          detail: { entityId: this._hold.entityId },
          bubbles: true,
          composed: true,
        }));
        this._cancelHold();
      }, 550),
    };
  }

  _moveHold(event) {
    if (!this._hold) return;
    if (Math.hypot(event.clientX - this._hold.x, event.clientY - this._hold.y) > 8) {
      this._cancelHold();
    }
  }

  _cancelHold() {
    if (this._hold && this._hold.timer) window.clearTimeout(this._hold.timer);
    this._hold = null;
  }

  _renderTabBar() {
    const nav = this.shadowRoot.querySelector(".tabbar");
    if (!nav || nav.childElementCount) return;
    const tabs = this._config().tabs;
    nav.style.setProperty("--water-tab-count", String(Math.max(1, tabs.length)));
    tabs.forEach((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.view = tab[0];
      button.setAttribute("aria-label", tab[2]);
      button.innerHTML = '<ha-icon icon="' + escapeHtml(tab[1]) + '"></ha-icon>'
        + '<span>' + escapeHtml(tab[2]) + '</span>';
      nav.appendChild(button);
    });
  }

  _viewMarkup(view) {
    if (view === "consumption") return this._consumptionMarkup();
    if (view === "meters") return this._metersMarkup();
    if (view === "diagnostics") return this._diagnosticsMarkup();
    return this._overviewMarkup();
  }

  _ensureView(view) {
    if (this._views.has(view)) return this._views.get(view);
    const root = document.createElement("section");
    root.className = "page page-" + view;
    root.dataset.viewRoot = view;
    root.hidden = true;
    root.innerHTML = this._viewMarkup(view);
    this.shadowRoot.querySelector(".work-canvas").appendChild(root);
    this._views.set(view, root);
    this._applyEntityTargets(root);
    return root;
  }

  _applyEntityTargets(root) {
    const entities = this._config().entities;
    root.querySelectorAll("[data-entity-role]").forEach((node) => {
      const entityId = entities[node.dataset.entityRole];
      if (entityId) node.dataset.entity = entityId;
      else node.removeAttribute("data-entity");
    });
  }

  _activateView(view, fromUser) {
    const next = VALID_VIEWS.has(view) ? view : WATER_APP.preferredView;
    const root = this._ensureView(next);
    this._views.forEach((node, key) => {
      node.hidden = key !== next;
    });
    this._view = next;
    saveStoredChoice(VIEW_STORAGE_KEY, next);
    this.shadowRoot.querySelectorAll(".tabbar [data-view]").forEach((button) => {
      const active = button.dataset.view === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    if (fromUser) {
      const controller = window.NikasPanelZoom && window.NikasPanelZoom.attach
        ? window.NikasPanelZoom.attach(this)
        : null;
      if (controller && controller.resetPosition) controller.resetPosition();
      else this.shadowRoot.querySelector(".canvas-viewport").scrollTop = 0;
    }
    if (next === "consumption") this._loadPeriod(this._period);
    this._queuePatch();
  }

  _overviewMarkup() {
    return '<article class="system-hero card">'
      + '<div class="hero-heading">'
      + '<div class="hero-icon"><ha-icon icon="mdi:home-flood"></ha-icon></div>'
      + '<div><p class="eyebrow">Водоснабжение</p>'
      + '<h1 data-overall-title>Получение данных…</h1>'
      + '<p data-overall-detail>Питьевая вода и полив</p></div>'
      + '</div>'
      + '<div class="pressure-grid">'
      + this._pressureCardMarkup("drinking", "pressure_drinking", "Питьевая вода", "mdi:cup-water", "Норма 2,4–3,1 бар")
      + this._pressureCardMarkup("irrigation", "pressure_irrigation", "Вода для полива", "mdi:sprinkler-variant", "Норма 2,5–3,5 бар")
      + '</div>'
      + '<section class="pressure-thresholds" aria-label="Пороговые значения давления">'
      + '<div class="thresholds-title"><ha-icon icon="mdi:format-list-checks"></ha-icon>'
      + '<strong>Пороговые значения</strong></div>'
      + '<div class="threshold-row drinking"><span>Питьевая</span>'
      + '<p><b class="bad">0</b> нет давления · <b class="ok">2,4–3,1</b> норма · '
      + '<b class="warn">остальное</b> отклонение</p></div>'
      + '<div class="threshold-row irrigation"><span>Полив</span>'
      + '<p><b class="bad">0</b> нет давления · <b class="bad">&lt;0,3 ≠ 0</b> аварийно · '
      + '<b class="warn">0,3–&lt;2,5</b> недостаточно · <b class="ok">2,5–3,5</b> норма · '
      + '<b class="warn">&gt;3,5–4,0</b> повышено · '
      + '<b class="bad">&gt;4,0</b> аварийно</p></div>'
      + '</section></article>'
      + '<section class="section-block"><div class="section-heading">'
      + '<div><p class="eyebrow">Текущие показания</p><h2>Счётчики</h2></div>'
      + '<ha-icon icon="mdi:counter"></ha-icon></div>'
      + '<div class="meter-reading-grid">'
      + this._readingTileMarkup("drinking_total", "Питьевая вода", "drinking")
      + this._readingTileMarkup("irrigation_total", "Полив", "irrigation")
      + '</div></section>'
      + '<section class="section-block consumption-snapshots"><div class="section-heading">'
      + '<div><p class="eyebrow">По данным Recorder</p><h2>Расход</h2></div>'
      + '<ha-icon icon="mdi:chart-timeline-variant"></ha-icon></div>'
      + '<div class="snapshot-grid">'
      + this._snapshotMarkup("24h", "За 24 часа")
      + this._snapshotMarkup("30d", "За 30 дней")
      + '</div></section>';
  }

  _pressureCardMarkup(kind, role, label, icon, range) {
    return '<button type="button" class="pressure-card unknown" data-pressure-card="' + kind
      + '" data-entity-role="' + role + '">'
      + '<span class="pressure-label"><ha-icon icon="' + icon + '"></ha-icon>' + label + '</span>'
      + '<strong data-pressure-value="' + kind + '">—</strong>'
      + '<span class="pressure-status" data-pressure-status="' + kind + '">Нет данных</span>'
      + '<small>' + range + '</small></button>';
  }

  _readingTileMarkup(role, label, category) {
    return '<button type="button" class="reading-tile ' + category + '" data-entity-role="' + role + '">'
      + '<span>' + label + '</span>'
      + '<strong data-value-role="' + role + '" data-format="volume-total">—</strong>'
      + '<small>Накопительное показание</small></button>';
  }

  _snapshotMarkup(period, label) {
    return '<article class="snapshot-card" data-snapshot="' + period + '">'
      + '<span>' + label + '</span><strong data-snapshot-total>Загрузка…</strong>'
      + '<div><small>Питьевая</small><b data-snapshot-drinking>—</b></div>'
      + '<div><small>Полив</small><b data-snapshot-irrigation>—</b></div>'
      + '</article>';
  }

  _consumptionMarkup() {
    return '<article class="card consumption-head">'
      + '<div><p class="eyebrow">Статистика Recorder</p><h1>Расход воды</h1>'
      + '<p>Питьевая вода и полив за выбранный период.</p></div>'
      + '<span class="period-badge" data-period-label>24 часа</span></article>'
      + '<section class="period-selector" aria-label="Период">'
      + '<button type="button" data-period="24h">24 ч</button>'
      + '<button type="button" data-period="7d">7 дней</button>'
      + '<button type="button" data-period="30d">30 дней</button>'
      + '<button type="button" data-period="12m">12 мес.</button></section>'
      + '<section class="stats-summary-grid">'
      + '<article class="stat-total drinking"><span>Питьевая вода</span><strong data-stat-drinking>—</strong></article>'
      + '<article class="stat-total irrigation"><span>Полив</span><strong data-stat-irrigation>—</strong></article>'
      + '<article class="stat-total combined"><span>Всего</span><strong data-stat-total>—</strong></article>'
      + '</section>'
      + '<article class="card chart-card">'
      + '<div class="chart-heading"><div><p class="eyebrow">Динамика</p><h2>Расход по интервалам</h2></div>'
      + '<div class="chart-legend"><span class="drinking">Питьевая</span><span class="irrigation">Полив</span></div></div>'
      + '<div class="chart-host" data-chart-host><div class="chart-state">Загрузка статистики…</div></div>'
      + '</article>';
  }

  _metersMarkup() {
    return '<article class="card page-heading"><p class="eyebrow">Элехант СВД-20</p>'
      + '<h1>Счётчики воды</h1><p>Показания, температура, питание и качество сигнала.</p></article>'
      + '<section class="meters-list">'
      + this._meterCardMarkup("drinking", "Питьевая вода", "mdi:cup-water")
      + this._meterCardMarkup("irrigation", "Полив", "mdi:sprinkler-variant")
      + '</section>';
  }

  _meterCardMarkup(prefix, title, icon) {
    return '<article class="meter-card card ' + prefix + '">'
      + '<div class="meter-card-head"><div class="meter-card-icon"><ha-icon icon="' + icon + '"></ha-icon></div>'
      + '<div><p>' + title + '</p><strong data-value-role="' + prefix + '_total" data-format="volume-total">—</strong></div>'
      + '<span class="data-badge unknown" data-meter-badge="' + prefix + '">Нет данных</span></div>'
      + '<div class="meter-properties">'
      + this._propertyMarkup(prefix + "_temperature", "mdi:thermometer", "Температура", "temperature")
      + this._propertyMarkup(prefix + "_battery", "mdi:battery", "Батарея", "integer")
      + this._propertyMarkup(prefix + "_signal", "mdi:signal", "Сигнал", "integer")
      + this._propertyMarkup(prefix + "_updated", "mdi:clock-outline", "Обновлено", "timestamp")
      + '</div></article>';
  }

  _propertyMarkup(role, icon, label, format) {
    return '<button type="button" class="meter-property" data-entity-role="' + role + '">'
      + '<ha-icon icon="' + icon + '"></ha-icon><span>' + label + '</span>'
      + '<strong data-value-role="' + role + '" data-format="' + format + '">—</strong></button>';
  }

  _diagnosticsMarkup() {
    const groups = [
      {
        title: "Давление · ZONT",
        roles: [
          ["pressure_drinking", "Питьевая вода"],
          ["pressure_irrigation", "Вода для полива"],
          ["zont_online", "Связь с ZONT"],
        ],
      },
      {
        title: "Счётчик · Питьевая вода",
        roles: [
          ["drinking_total", "Показания"],
          ["drinking_temperature", "Температура"],
          ["drinking_battery", "Батарея"],
          ["drinking_signal", "Сигнал"],
          ["drinking_updated", "Обновлено"],
        ],
      },
      {
        title: "Счётчик · Полив",
        roles: [
          ["irrigation_total", "Показания"],
          ["irrigation_temperature", "Температура"],
          ["irrigation_battery", "Батарея"],
          ["irrigation_signal", "Сигнал"],
          ["irrigation_updated", "Обновлено"],
        ],
      },
    ];
    let content = '<article class="card page-heading"><p class="eyebrow">Обслуживание</p>'
      + '<h1>Диагностика</h1><p>Фактически привязанные сущности и их доступность.</p></article>'
      + '<article class="card source-card"><div><span>Источники данных</span>'
      + '<strong>ZONT · Elehant · Recorder</strong></div><div><span>Режим</span>'
      + '<strong>Только чтение</strong></div><div><span>Интерфейс</span>'
      + '<strong>UI v' + WATER_APP.uiVersion + '</strong></div></article>';
    groups.forEach((group) => {
      content += '<section class="diagnostic-group"><h2>' + group.title + '</h2><div class="diagnostic-list">';
      group.roles.forEach((item) => {
        content += '<button type="button" class="diagnostic-entity" data-diagnostic-role="' + item[0]
          + '" data-entity-role="' + item[0] + '">'
          + '<div><strong>' + item[1] + '</strong><code data-diagnostic-id="' + item[0] + '">—</code></div>'
          + '<span data-diagnostic-state="' + item[0] + '">Нет данных</span>'
          + '<small data-diagnostic-updated="' + item[0] + '">—</small>'
          + '<pre data-diagnostic-attrs="' + item[0] + '">{}</pre></button>';
      });
      content += '</div></section>';
    });
    return content;
  }

  _queuePatch() {
    if (this._patchQueued) return;
    this._patchQueued = true;
    const schedule = window.requestAnimationFrame || function (callback) { queueMicrotask(callback); };
    schedule(() => {
      this._patchQueued = false;
      this._patch();
    });
  }

  _patch() {
    this._mountShell();
    if (!this._shellMounted) return;
    const config = this._config();
    this._setText(".header-title strong", config.title);
    this._setText(".header-title span", "UI v" + config.uiVersion);
    this._views.forEach((root) => this._applyEntityTargets(root));
    this._patchGenericValues();
    this._patchPressures();
    this._patchMeterBadges();
    this._patchDiagnostics();
    this._patchPeriodControls();
    this._patchStatistics();
    if (!this._overviewStatsRequested && this._hass && typeof this._hass.callWS === "function") {
      this._overviewStatsRequested = true;
      this._loadPeriod("24h");
      this._loadPeriod("30d");
    }
    window.NikasPanelZoom && window.NikasPanelZoom.attach
      ? window.NikasPanelZoom.attach(this, { min: 0.75, max: 2.0 }).bind()
      : null;
  }

  _setText(selector, value, root) {
    const scope = root || this.shadowRoot;
    const node = scope.querySelector(selector);
    const text = String(value == null ? "" : value);
    if (node && node.textContent !== text) node.textContent = text;
  }

  _state(role) {
    const entityId = this._config().entities[role];
    return entityId && this._hass && this._hass.states ? this._hass.states[entityId] : null;
  }

  _isAvailable(state) {
    return Boolean(state) && !BAD_STATES.has(String(state.state || "").trim().toLowerCase());
  }

  _formatNumber(value, digits) {
    if (!Number.isFinite(value)) return "—";
    return new Intl.NumberFormat(this._hass && this._hass.locale
      ? this._hass.locale.language || "ru"
      : "ru", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  }

  _formatState(role, format) {
    const state = this._state(role);
    if (!this._isAvailable(state)) return "Нет данных";
    if (format === "timestamp") {
      const date = new Date(state.state);
      if (!Number.isFinite(date.getTime())) return "Нет данных";
      return new Intl.DateTimeFormat("ru", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    }
    if (role === "zont_online") {
      if (state.state === "on") return "Доступен";
      if (state.state === "off") return "Нет связи";
      return "Нет данных";
    }
    const value = numeric(state.state);
    const unit = state.attributes && state.attributes.unit_of_measurement
      ? state.attributes.unit_of_measurement
      : "";
    if (value == null) return String(state.state);
    let digits = 2;
    if (format === "volume-total") digits = 3;
    else if (format === "temperature") digits = 1;
    else if (format === "integer") digits = 0;
    const number = this._formatNumber(value, digits);
    return unit ? number + " " + unit : number;
  }

  _patchGenericValues() {
    this.shadowRoot.querySelectorAll("[data-value-role]").forEach((node) => {
      const next = this._formatState(node.dataset.valueRole, node.dataset.format || "");
      if (node.textContent !== next) node.textContent = next;
    });
  }

  _pressureEvaluation(kind) {
    const role = kind === "drinking" ? "pressure_drinking" : "pressure_irrigation";
    const state = this._state(role);
    const value = this._isAvailable(state) ? numeric(state.state) : null;
    if (value == null) return { tone: "unknown", label: "Нет данных", value: null };
    const policy = this._config().pressurePolicy[kind] || WATER_APP.pressurePolicy[kind];
    if (kind === "drinking") {
      const min = Number(policy.normal_min != null ? policy.normal_min : policy.normalMin);
      const max = Number(policy.normal_max != null ? policy.normal_max : policy.normalMax);
      if (value === 0) return { tone: "bad", label: "Нет давления", value: value };
      if (value >= min && value <= max) return { tone: "ok", label: "Норма", value: value };
      return { tone: "warn", label: "Отклонение", value: value };
    }
    const criticalLow = Number(policy.critical_low_below != null
      ? policy.critical_low_below
      : policy.criticalLowBelow);
    const normalMin = Number(policy.normal_min != null ? policy.normal_min : policy.normalMin);
    const normalMax = Number(policy.normal_max != null ? policy.normal_max : policy.normalMax);
    const warningHighMax = Number(policy.warning_high_max != null
      ? policy.warning_high_max
      : policy.warningHighMax);
    if (value === 0) return { tone: "bad", label: "Нет давления", value: value };
    if (value < criticalLow) return { tone: "bad", label: "Аварийно низкое", value: value };
    if (value < normalMin) return { tone: "warn", label: "Недостаточное", value: value };
    if (value <= normalMax) return { tone: "ok", label: "Норма", value: value };
    if (value <= warningHighMax) return { tone: "warn", label: "Повышенное", value: value };
    return { tone: "bad", label: "Аварийно высокое", value: value };
  }

  _patchPressures() {
    const evaluations = {
      drinking: this._pressureEvaluation("drinking"),
      irrigation: this._pressureEvaluation("irrigation"),
    };
    Object.entries(evaluations).forEach((entry) => {
      const kind = entry[0];
      const result = entry[1];
      const card = this.shadowRoot.querySelector('[data-pressure-card="' + kind + '"]');
      if (card) {
        ["ok", "warn", "bad", "unknown"].forEach((tone) => {
          card.classList.toggle(tone, tone === result.tone);
        });
      }
      this._setText('[data-pressure-value="' + kind + '"]',
        result.value == null ? "—" : this._formatNumber(result.value, 2) + " бар");
      this._setText('[data-pressure-status="' + kind + '"]', result.label);
    });
    const tones = Object.values(evaluations).map((item) => item.tone);
    let tone = "ok";
    let title = "Давление в норме";
    let detail = "Питьевая вода и полив";
    if (tones.includes("bad")) {
      tone = "bad";
      title = "Требуется внимание";
      detail = "Зафиксировано критическое давление";
    } else if (tones.includes("warn")) {
      tone = "warn";
      title = "Есть отклонение";
      detail = "Давление вне рабочего диапазона";
    } else if (tones.includes("unknown")) {
      tone = "unknown";
      title = "Не все данные доступны";
      detail = "Проверьте источники давления";
    }
    const hero = this.shadowRoot.querySelector(".system-hero");
    if (hero) {
      ["ok", "warn", "bad", "unknown"].forEach((name) => {
        hero.classList.toggle(name, name === tone);
      });
    }
    this._setText("[data-overall-title]", title);
    this._setText("[data-overall-detail]", detail);
  }

  _patchMeterBadges() {
    ["drinking", "irrigation"].forEach((prefix) => {
      const state = this._state(prefix + "_total");
      const badge = this.shadowRoot.querySelector('[data-meter-badge="' + prefix + '"]');
      if (!badge) return;
      const available = this._isAvailable(state) && numeric(state.state) != null;
      badge.textContent = available ? "Данные получены" : "Нет данных";
      badge.classList.toggle("ok", available);
      badge.classList.toggle("unknown", !available);
    });
  }

  _diagnosticAttributes(state) {
    if (!state || !state.attributes) return {};
    const allowed = ["friendly_name", "device_class", "state_class", "unit_of_measurement", "last_reset"];
    const result = {};
    allowed.forEach((key) => {
      if (state.attributes[key] != null) result[key] = state.attributes[key];
    });
    return result;
  }

  _patchDiagnostics() {
    const root = this._views.get("diagnostics");
    if (!root) return;
    const entities = this._config().entities;
    root.querySelectorAll("[data-diagnostic-role]").forEach((card) => {
      const role = card.dataset.diagnosticRole;
      const entityId = entities[role] || "Не привязано";
      const state = this._state(role);
      const available = this._isAvailable(state);
      this._setText('[data-diagnostic-id="' + role + '"]', entityId, root);
      this._setText('[data-diagnostic-state="' + role + '"]',
        available ? this._formatState(role, "") : "Нет данных", root);
      this._setText('[data-diagnostic-updated="' + role + '"]',
        state && state.last_updated ? this._formatDateTime(state.last_updated) : "—", root);
      this._setText('[data-diagnostic-attrs="' + role + '"]',
        JSON.stringify(this._diagnosticAttributes(state), null, 2), root);
      card.classList.toggle("unavailable", !available);
    });
  }

  _formatDateTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ru", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  _periodDefinition(key) {
    const end = new Date();
    const start = new Date(end);
    let period = "hour";
    let label = "24 часа";
    if (key === "7d") {
      start.setDate(start.getDate() - 7);
      period = "day";
      label = "7 дней";
    } else if (key === "30d") {
      start.setDate(start.getDate() - 30);
      period = "day";
      label = "30 дней";
    } else if (key === "12m") {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      start.setMonth(start.getMonth() - 11);
      period = "month";
      label = "12 месяцев";
    } else {
      start.setHours(start.getHours() - 24);
    }
    return { key: key, start: start, end: end, period: period, label: label };
  }

  _selectPeriod(key) {
    if (!VALID_PERIODS.has(key) || key === this._period) return;
    this._period = key;
    saveStoredChoice(PERIOD_STORAGE_KEY, key);
    this._patchPeriodControls();
    this._renderActiveStatistics();
    this._loadPeriod(key);
  }

  _patchPeriodControls() {
    const root = this._views.get("consumption");
    if (!root) return;
    root.querySelectorAll("[data-period]").forEach((button) => {
      const active = button.dataset.period === this._period;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    this._setText("[data-period-label]", this._periodDefinition(this._period).label, root);
  }

  _withTimeout(promise, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("Recorder timeout")), milliseconds);
      Promise.resolve(promise).then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      }, (error) => {
        window.clearTimeout(timer);
        reject(error);
      });
    });
  }

  _loadPeriod(key) {
    if (!VALID_PERIODS.has(key)) return Promise.resolve(null);
    const existing = this._statsLoads.get(key);
    if (existing) return existing.promise;
    const definition = this._periodDefinition(key);
    const entities = this._config().entities;
    const statisticIds = [entities.drinking_total, entities.irrigation_total].filter(Boolean);
    const load = {
      key: key,
      status: "loading",
      result: null,
      error: null,
      promise: null,
    };
    load.promise = this._statsPool.run(() => {
      if (!this._hass || typeof this._hass.callWS !== "function") {
        throw new Error("Recorder WebSocket API unavailable");
      }
      return this._withTimeout(this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: definition.start.toISOString(),
        end_time: definition.end.toISOString(),
        statistic_ids: statisticIds,
        period: definition.period,
        types: ["change", "state", "sum"],
      }), 60_000);
    }).then((raw) => {
      load.status = "complete";
      load.result = this._normalizeStatistics(raw, definition);
      this._queuePatch();
      return load;
    }).catch((error) => {
      load.status = "error";
      load.error = error;
      this._queuePatch();
      return load;
    });
    this._statsLoads.set(key, load);
    this._queuePatch();
    return load.promise;
  }

  _seriesRows(raw, entityId) {
    const rows = raw && entityId && Array.isArray(raw[entityId]) ? raw[entityId] : [];
    let previous = null;
    return rows.map((row) => {
      let value = numeric(row && row.change);
      const cumulative = numeric(row && (row.sum != null ? row.sum : row.state));
      if (value == null && cumulative != null && previous != null) {
        const delta = cumulative - previous;
        value = delta >= 0 ? delta : null;
      }
      if (cumulative != null) previous = cumulative;
      const start = numeric(row && row.start);
      return {
        start: start,
        value: value != null && value >= 0 ? value : null,
      };
    }).filter((row) => row.start != null);
  }

  _normalizeStatistics(raw, definition) {
    const entities = this._config().entities;
    const drinking = this._seriesRows(raw, entities.drinking_total);
    const irrigation = this._seriesRows(raw, entities.irrigation_total);
    const buckets = new Map();
    function add(series, key) {
      series.forEach((row) => {
        const id = String(row.start);
        if (!buckets.has(id)) buckets.set(id, { start: row.start, drinking: null, irrigation: null });
        buckets.get(id)[key] = row.value;
      });
    }
    add(drinking, "drinking");
    add(irrigation, "irrigation");
    const values = Array.from(buckets.values()).sort((left, right) => left.start - right.start);
    function sum(key) {
      const numbers = values.map((item) => item[key]).filter((value) => Number.isFinite(value));
      return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null;
    }
    const drinkingTotal = sum("drinking");
    const irrigationTotal = sum("irrigation");
    return {
      definition: definition,
      buckets: values,
      drinking: drinkingTotal,
      irrigation: irrigationTotal,
      total: drinkingTotal == null && irrigationTotal == null
        ? null
        : (drinkingTotal || 0) + (irrigationTotal || 0),
    };
  }

  _formatVolume(value) {
    if (!Number.isFinite(value)) return "—";
    if (value < 1) return this._formatNumber(value * 1000, value < 0.01 ? 1 : 0) + " л";
    return this._formatNumber(value, 2) + " м³";
  }

  _patchStatistics() {
    ["24h", "30d"].forEach((key) => this._patchSnapshot(key));
    this._renderActiveStatistics();
  }

  _patchSnapshot(key) {
    const root = this._views.get("overview");
    if (!root) return;
    const card = root.querySelector('[data-snapshot="' + key + '"]');
    if (!card) return;
    const load = this._statsLoads.get(key);
    let total = "Загрузка…";
    let drinking = "—";
    let irrigation = "—";
    let state = "loading";
    if (load && load.status === "error") {
      total = "Recorder недоступен";
      state = "error";
    } else if (load && load.status === "complete") {
      state = load.result && load.result.total != null ? "ready" : "empty";
      total = state === "ready" ? this._formatVolume(load.result.total) : "Нет записей";
      drinking = this._formatVolume(load.result.drinking);
      irrigation = this._formatVolume(load.result.irrigation);
    }
    this._setText("[data-snapshot-total]", total, card);
    this._setText("[data-snapshot-drinking]", drinking, card);
    this._setText("[data-snapshot-irrigation]", irrigation, card);
    card.dataset.state = state;
  }

  _renderActiveStatistics() {
    const root = this._views.get("consumption");
    if (!root) return;
    const load = this._statsLoads.get(this._period);
    const host = root.querySelector("[data-chart-host]");
    if (!load || load.status === "loading") {
      this._setText("[data-stat-drinking]", "—", root);
      this._setText("[data-stat-irrigation]", "—", root);
      this._setText("[data-stat-total]", "—", root);
      if (host && host.dataset.renderState !== "loading") {
        host.dataset.renderState = "loading";
        host.innerHTML = '<div class="chart-state">Загрузка статистики…</div>';
      }
      return;
    }
    if (load.status === "error") {
      this._setText("[data-stat-drinking]", "—", root);
      this._setText("[data-stat-irrigation]", "—", root);
      this._setText("[data-stat-total]", "—", root);
      if (host && host.dataset.renderState !== "error") {
        host.dataset.renderState = "error";
        host.innerHTML = '<div class="chart-state error">Recorder недоступен</div>';
      }
      return;
    }
    const result = load.result;
    this._setText("[data-stat-drinking]", this._formatVolume(result.drinking), root);
    this._setText("[data-stat-irrigation]", this._formatVolume(result.irrigation), root);
    this._setText("[data-stat-total]", this._formatVolume(result.total), root);
    const signature = this._period + ":" + result.buckets.length + ":"
      + String(result.total) + ":" + String(result.drinking) + ":" + String(result.irrigation);
    if (host && host.dataset.renderState !== signature) {
      host.dataset.renderState = signature;
      host.innerHTML = this._chartMarkup(result);
    }
  }

  _chartMarkup(result) {
    const buckets = result.buckets || [];
    const values = [];
    buckets.forEach((bucket) => {
      if (Number.isFinite(bucket.drinking)) values.push(bucket.drinking);
      if (Number.isFinite(bucket.irrigation)) values.push(bucket.irrigation);
    });
    if (!values.length) return '<div class="chart-state">Нет записей за выбранный период</div>';
    const max = Math.max.apply(null, values.concat([0.000001]));
    const definition = result.definition;
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 6));
    let bars = '<div class="bar-chart" style="--bucket-count:' + buckets.length + '">';
    buckets.forEach((bucket, index) => {
      const drinkingHeight = Number.isFinite(bucket.drinking) ? Math.max(1, bucket.drinking / max * 100) : 0;
      const irrigationHeight = Number.isFinite(bucket.irrigation) ? Math.max(1, bucket.irrigation / max * 100) : 0;
      const label = index % labelEvery === 0 || index === buckets.length - 1
        ? this._bucketLabel(bucket.start, definition.period)
        : "";
      bars += '<div class="bar-bucket" title="' + escapeHtml(this._bucketTitle(bucket, definition.period)) + '">'
        + '<div class="bars"><i class="drinking" style="height:' + drinkingHeight.toFixed(2) + '%"></i>'
        + '<i class="irrigation" style="height:' + irrigationHeight.toFixed(2) + '%"></i></div>'
        + '<span>' + escapeHtml(label) + '</span></div>';
    });
    bars += '</div>';
    return bars;
  }

  _bucketLabel(timestamp, period) {
    const date = new Date(Number(timestamp));
    if (period === "hour") {
      return new Intl.DateTimeFormat("ru", { hour: "2-digit" }).format(date);
    }
    if (period === "month") {
      return new Intl.DateTimeFormat("ru", { month: "short" }).format(date).replace(".", "");
    }
    return new Intl.DateTimeFormat("ru", { day: "2-digit", month: "2-digit" }).format(date);
  }

  _bucketTitle(bucket, period) {
    return this._bucketLabel(bucket.start, period) + ": питьевая "
      + this._formatVolume(bucket.drinking) + ", полив " + this._formatVolume(bucket.irrigation);
  }

  async _refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    const button = this.shadowRoot.querySelector("#refresh");
    if (button) {
      button.classList.add("busy");
      button.setAttribute("aria-busy", "true");
    }
    const entities = Array.from(new Set(Object.values(this._config().entities).filter(Boolean)));
    const refreshPeriods = this._view === "overview" ? ["24h", "30d"] : [this._period];
    refreshPeriods.forEach((key) => this._statsLoads.delete(key));
    try {
      if (this._hass && typeof this._hass.callService === "function") {
        await this._hass.callService("homeassistant", "update_entity", { entity_id: entities });
      }
      await Promise.all(refreshPeriods.map((key) => this._loadPeriod(key)));
    } catch (_error) {
      this._showToast("Обновить данные не удалось");
    } finally {
      this._refreshing = false;
      if (button) {
        button.classList.remove("busy");
        button.removeAttribute("aria-busy");
      }
      this._queuePatch();
    }
  }

  _showToast(message) {
    const toast = this.shadowRoot.querySelector(".panel-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    window.setTimeout(() => toast.classList.remove("visible"), 2200);
  }
}

if (!customElements.get("nikas-water-accounting-panel")) {
  customElements.define("nikas-water-accounting-panel", NikaSWaterAccountingPanel);
}

// app.js
// ============================================================
// LifeOps Frontend Logic (Backend + Offline fallback)
// - Backend: FastAPI (/state, /logs, /settings, /coach/snix)
// - Fallback: localStorage
//
// Objetivo desta versão:
// ✅ Manter TODA a inteligência (KPIs, risco, gatilhos, correlações, planos, Snix)
// ✅ Corrigir o “bagunçado no celular” organizando INSIGHTS em BLOCOS colapsáveis
//    (alertas, tendências, relações, planos, qualidade do dado) com severidade.
// ============================================================

/** Metas padrão (compatível com backend) */
const DEFAULT_GOALS = {
  sleepMin: 7.0,
  workoutsPerWeek: 3,
  foodTarget: 4,
  anxietyMax: 6,
};

/** Config do dashboard */
const KPI_DAYS = 7;

// Gráfico:
// - "month": mês atual
// - "rolling": últimos CHART_DAYS dias
let chartMode = "month";
const CHART_DAYS = 14;

/** Snix (IA) UX */
const SNIX_COOLDOWN_MS = 8000; // anti spam
const SNIX_TIMEOUT_MS = 45000;

/** Estado global */
let appData = {
  logs: [],
  goals: { ...DEFAULT_GOALS },
  theme: "dark",
};

let charts = {};

/** Backend base */
const API_KEY = "lifeops_api_base";

function normalizeBaseUrl(url) {
  if (!url) return "";
  let u = String(url).trim().replace(/\/+$/, "");

  // força https quando vier sem protocolo
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;

  // correção automática do typo clássico
  u = u.replace("viniciuskanh-lifeops.hf.space", "viniciuskhan-lifeops.hf.space");

  return u;
}

function getApiBase() {
  // 1) se estiver rodando dentro de um Space (mesma origem), usa a própria origem
  if (window.location.hostname.endsWith("hf.space")) {
    return window.location.origin;
  }

  // 2) se usuário configurou manualmente, usa (normalizado)
  const saved = normalizeBaseUrl(localStorage.getItem(API_KEY));
  if (saved) return saved;

  // 3) default correto (normalizado)
  return normalizeBaseUrl("https://viniciuskhan-lifeops.hf.space");
}

function setApiBase(url) {
  localStorage.setItem(API_KEY, normalizeBaseUrl(url));
}



function setApiBase(url) {
  localStorage.setItem(API_KEY, url);
}

/** Util: request */
async function api(path, { method = "GET", body = null, timeoutMs = 20000 } = {}) {
  const base = getApiBase();
  const opts = { method, headers: {} };

  if (body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  opts.signal = controller.signal;

  try {
    const res = await fetch(`${base}${path}`, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${method} ${path} -> ${res.status} ${text}`);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : null;
  } finally {
    clearTimeout(id);
  }
}

/** Util: normaliza/merge */
function normalizeData(data) {
  const out = data && typeof data === "object" ? data : {};
  out.logs = Array.isArray(out.logs) ? out.logs : [];
  out.goals = { ...DEFAULT_GOALS, ...(out.goals || {}) };
  out.theme = out.theme === "light" ? "light" : "dark";

  out.logs = out.logs
    .filter((l) => l && typeof l === "object" && typeof l.date === "string")
    .map((l) => ({
      date: l.date,
      sleep: Number(l.sleep ?? 0),
      sleepQual: Number(l.sleepQual ?? 3),
      trained: !!l.trained,
      trainMin: Number(l.trainMin ?? 0),
      trainType: l.trainType ?? "",
      foodScore: Number(l.foodScore ?? 3),
      water: !!l.water,
      meals: !!l.meals,
      mood: Number(l.mood ?? 7),
      anxiety: Number(l.anxiety ?? 3),
      notes: String(l.notes ?? ""),
    }));

  return out;
}

/** Persistência local (offline) */
function loadLocal() {
  const stored = localStorage.getItem("lifeops_data");
  if (stored) {
    try {
      appData = normalizeData(JSON.parse(stored));
    } catch {
      // ignora
    }
  }
}
function saveLocal() {
  localStorage.setItem("lifeops_data", JSON.stringify(appData));
}

/** Carrega do backend, com fallback local */
async function loadData() {
  loadLocal();

  try {
    const remote = await api("/state");
    appData = normalizeData(remote);
    saveLocal();
  } catch (e) {
    console.warn("Backend indisponível, usando localStorage.", e);
  }

  applyTheme(appData.theme);
  populateSettings();
  updateBackendLabel();
}

/** Inicialização */
document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  initDateDisplay();
  setupLucide();
  renderDashboard();

  const dateInput = document.getElementById("inputDate");
  if (dateInput) dateInput.valueAsDate = new Date();
});

// Re-render em mudança de tamanho (ajuda no mobile: blocos abertos/fechados por breakpoint)
window.addEventListener("resize", () => {
  // evita re-render agressivo: só ajusta insights
  try {
    const kpiLogs = getLastNDaysLogs(KPI_DAYS);
    generateInsights(kpiLogs);
  } catch {
    // ignora
  }
});

/** UI helpers */
function setupLucide() {
  if (window.lucide) lucide.createIcons();
}

/** Data do header */
function initDateDisplay() {
  const now = new Date();
  const dias = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const meses = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  const dd = String(now.getDate()).padStart(2, "0");
  const mm = meses[now.getMonth()];
  const yyyy = now.getFullYear();
  const dow = dias[now.getDay()];

  const el = document.getElementById("currentDate");
  if (el) el.innerText = `${dow}, ${dd} ${mm} ${yyyy}`;
}

function populateSettings() {
  const goalSleep = document.getElementById("goalSleep");
  const goalWorkout = document.getElementById("goalWorkout");
  const goalAnxiety = document.getElementById("goalAnxiety");
  const reportMonth = document.getElementById("reportMonth");

  if (goalSleep) goalSleep.value = appData.goals.sleepMin;
  if (goalWorkout) goalWorkout.value = appData.goals.workoutsPerWeek;
  if (goalAnxiety) goalAnxiety.value = appData.goals.anxietyMax;
  if (reportMonth) reportMonth.value = new Date().toISOString().slice(0, 7);
}

function updateBackendLabel() {
  const el = document.getElementById("backendUrlLabel");
  if (el) el.textContent = getApiBase();
}

/** Core render */
function renderDashboard() {
  appData.logs.sort((a, b) => new Date(b.date) - new Date(a.date));

  const kpiLogs = getLastNDaysLogs(KPI_DAYS);
  const chartSeries = chartMode === "month" ? getCurrentMonthSeries() : getRollingSeries(CHART_DAYS);

  renderKPIs(kpiLogs);
  renderStreak();
  renderCharts(chartSeries);
  renderHistory();
  generateInsights(kpiLogs);
}

/** ===== Datas robustas ===== */
function toISODate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function indexLogsByDate(logs) {
  const map = new Map();
  for (const l of logs) map.set(l.date, l);
  return map;
}
function buildDateWindowFrom(startISO, days) {
  const [y, m, d] = startISO.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  start.setHours(0, 0, 0, 0);

  const out = [];
  for (let i = 0; i < days; i++) out.push(toISODate(addDays(start, i)));
  return out;
}

/** Últimos N dias */
function getLastNDaysLogs(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = addDays(today, -(days - 1));
  const startISO = toISODate(start);

  const windowDates = new Set(buildDateWindowFrom(startISO, days));
  return appData.logs.filter((l) => windowDates.has(l.date));
}

/** Série rolling */
function getRollingSeries(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = addDays(today, -(days - 1));
  const dates = buildDateWindowFrom(toISODate(start), days);

  const byDate = indexLogsByDate(appData.logs);
  return dates.map((date) => {
    const log = byDate.get(date);
    return {
      date,
      sleep: log ? Number(log.sleep) : null,
      mood: log ? Number(log.mood) : null,
      anxiety: log ? Number(log.anxiety) : null,
    };
  });
}

/** Série mês atual */
function getCurrentMonthSeries() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const first = new Date(y, m, 1);
  first.setHours(0, 0, 0, 0);

  const nextMonth = new Date(y, m + 1, 1);
  nextMonth.setHours(0, 0, 0, 0);

  const days = Math.round((nextMonth - first) / 86400000);
  const dates = buildDateWindowFrom(toISODate(first), days);

  const byDate = indexLogsByDate(appData.logs);
  return dates.map((date) => {
    const log = byDate.get(date);
    return {
      date,
      sleep: log ? Number(log.sleep) : null,
      mood: log ? Number(log.mood) : null,
      anxiety: log ? Number(log.anxiety) : null,
    };
  });
}

/** ===== Helpers analíticos ===== */
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function stdev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const v = mean(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}
function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 4) return null;
  const mx = mean(xs);
  const my = mean(ys);
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const denx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const deny = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  if (denx === 0 || deny === 0) return null;
  return num / (denx * deny);
}
function formatDM(iso) {
  // YYYY-MM-DD -> DD/MM
  if (!iso || iso.length !== 10) return iso || "";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function pickTopK(items, k, scoreFn) {
  return [...items].sort((a, b) => scoreFn(b) - scoreFn(a)).slice(0, k);
}
function noteKeywordsScore(note) {
  // heurística simples: se aparecerem termos que costumam acompanhar stress, soma pontos
  const s = (note || "").toLowerCase();
  const keys = [
    { k: "prova", w: 1 },
    { k: "trabalho", w: 1 },
    { k: "prazo", w: 1 },
    { k: "cansa", w: 1 },
    { k: "ansios", w: 2 },
    { k: "pânico", w: 3 },
    { k: "panico", w: 3 },
    { k: "discuss", w: 2 },
    { k: "briga", w: 2 },
    { k: "dor", w: 1 },
    { k: "insônia", w: 2 },
    { k: "insonia", w: 2 },
    { k: "estresse", w: 2 },
    { k: "stress", w: 2 },
  ];
  let score = 0;
  for (const { k, w } of keys) if (s.includes(k)) score += w;
  return score;
}

/** ===== KPIs ===== */
function renderKPIs(recentLogs) {
  const kpiSleep = document.getElementById("kpiSleep");
  const kpiWorkout = document.getElementById("kpiWorkout");
  const kpiFood = document.getElementById("kpiFood");
  const kpiMood = document.getElementById("kpiMood");

  const s1 = document.getElementById("statusSleep");
  const s2 = document.getElementById("statusWorkout");
  const s3 = document.getElementById("statusFood");
  const s4 = document.getElementById("statusMood");

  // limpa classes “de estado” que podem acumular
  kpiSleep?.classList.remove("text-green-400");
  kpiWorkout?.classList.remove("text-[var(--accent)]");

  if (!recentLogs.length) {
    kpiSleep && (kpiSleep.innerText = "--");
    kpiWorkout && (kpiWorkout.innerText = "--");
    kpiFood && (kpiFood.innerText = "--");
    kpiMood && (kpiMood.innerText = "--");

    s1 && (s1.innerHTML = `<div class="w-2 h-2 rounded-full bg-gray-500"></div> Sem dados`);
    s2 && (s2.innerHTML = `<div class="w-2 h-2 rounded-full bg-gray-500"></div> Sem dados`);
    s3 && (s3.innerHTML = `<div class="w-2 h-2 rounded-full bg-gray-500"></div> Sem dados`);
    s4 && (s4.innerHTML = `<div class="w-2 h-2 rounded-full bg-gray-500"></div> Sem dados`);
    return;
  }

  let n = 0,
    sleepSum = 0,
    foodSum = 0,
    moodSum = 0,
    anxSum = 0,
    workouts = 0,
    highAnxDays = 0;

  for (const l of recentLogs) {
    n++;
    sleepSum += Number(l.sleep);
    foodSum += Number(l.foodScore);
    moodSum += Number(l.mood);
    anxSum += Number(l.anxiety);
    if (l.trained) workouts++;
    if (Number(l.anxiety) > appData.goals.anxietyMax) highAnxDays++;
  }

  const avgSleep = sleepSum / n;
  const avgFood = foodSum / n;
  const avgMood = moodSum / n;
  const avgAnx = anxSum / n;

  // Sono
  kpiSleep && (kpiSleep.innerText = `${avgSleep.toFixed(1)}h`);
  if (avgSleep >= appData.goals.sleepMin) {
    kpiSleep?.classList.add("text-green-400");
    s1 && (s1.innerHTML = `<div class="w-2 h-2 rounded-full bg-green-500"></div> Na meta`);
  } else {
    s1 && (s1.innerHTML = `<div class="w-2 h-2 rounded-full bg-red-400"></div> Abaixo`);
  }

  // Treino (na janela de KPI_DAYS)
  kpiWorkout && (kpiWorkout.innerText = `${workouts}x`);
  if (workouts >= appData.goals.workoutsPerWeek) {
    kpiWorkout?.classList.add("text-[var(--accent)]");
    s2 && (s2.innerHTML = `<div class="w-2 h-2 rounded-full bg-[var(--accent)]"></div> Em dia`);
  } else {
    s2 && (s2.innerHTML = `<div class="w-2 h-2 rounded-full bg-yellow-500"></div> Foco`);
  }

  // Nutrição
  kpiFood && (kpiFood.innerText = `${avgFood.toFixed(1)}`);
  if (avgFood >= appData.goals.foodTarget) {
    s3 && (s3.innerHTML = `<div class="w-2 h-2 rounded-full bg-green-500"></div> Ok`);
  } else {
    s3 && (s3.innerHTML = `<div class="w-2 h-2 rounded-full bg-yellow-500"></div> Ajustar`);
  }

  // Humor + Ansiedade (status central)
  kpiMood && (kpiMood.innerText = `${avgMood.toFixed(1)}`);
  if (highAnxDays >= 2) {
    s4 && (s4.innerHTML = `<div class="w-2 h-2 rounded-full bg-red-500"></div> Ansiedade alta (${highAnxDays}d)`);
  } else if (avgAnx > appData.goals.anxietyMax) {
    s4 && (s4.innerHTML = `<div class="w-2 h-2 rounded-full bg-red-500"></div> Ansiedade acima`);
  } else if (avgMood < 5) {
    s4 && (s4.innerHTML = `<div class="w-2 h-2 rounded-full bg-yellow-500"></div> Humor baixo`);
  } else {
    s4 && (s4.innerHTML = `<div class="w-2 h-2 rounded-full bg-green-500"></div> Estável`);
  }
}

/** Streak + Consistency */
function renderStreak() {
  let streak = 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const datesSet = new Set(appData.logs.map((l) => l.date));
  const todayStr = toISODate(today);
  const yesterdayStr = toISODate(addDays(today, -1));

  if (datesSet.has(todayStr) || datesSet.has(yesterdayStr)) {
    let current = datesSet.has(todayStr) ? today : addDays(today, -1);
    while (true) {
      const ds = toISODate(current);
      if (datesSet.has(ds)) {
        streak++;
        current = addDays(current, -1);
      } else break;
    }
  }

  const streakEl = document.getElementById("streakDisplay");
  streakEl && (streakEl.innerText = String(streak));

  const recentCount = getLastNDaysLogs(KPI_DAYS).length;
  const percentage = Math.round((recentCount / KPI_DAYS) * 100);
  const consEl = document.getElementById("consistencyDisplay");
  consEl && (consEl.innerText = `${percentage}%`);
}

/** Charts: Sono + Humor + Ansiedade + linhas de meta */
function renderCharts(series) {
  const canvas = document.getElementById("trendsChart");
  if (!canvas || !window.Chart) return;

  const labels = series.map((p) => p.date.slice(5)); // MM-DD
  const ctx = canvas.getContext("2d");
  if (charts.trends) charts.trends.destroy();

  const isDark = appData.theme === "dark";
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
  const textColor = isDark ? "#94a3b8" : "#64748b";

  // Linhas de referência (meta sono e limite ansiedade)
  const sleepGoalLine = series.map(() => Number(appData.goals.sleepMin));
  const anxietyLimitLine = series.map(() => Number(appData.goals.anxietyMax));

  charts.trends = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Sono (h)",
          data: series.map((p) => p.sleep),
          borderColor: "#38bdf8",
          borderWidth: 2,
          tension: 0.35,
          spanGaps: true,
          yAxisID: "y",
        },
        {
          label: "Meta Sono",
          data: sleepGoalLine,
          borderColor: "rgba(56,189,248,0.35)",
          borderWidth: 1,
          borderDash: [4, 4],
          tension: 0,
          pointRadius: 0,
          spanGaps: true,
          yAxisID: "y",
        },
        {
          label: "Humor (0-10)",
          data: series.map((p) => p.mood),
          borderColor: "#a855f7",
          borderWidth: 2,
          tension: 0.35,
          spanGaps: true,
          yAxisID: "y1",
        },
        {
          label: "Ansiedade (0-10)",
          data: series.map((p) => p.anxiety),
          borderColor: "#f87171",
          borderWidth: 2,
          borderDash: [6, 6],
          tension: 0.35,
          spanGaps: true,
          yAxisID: "y1",
        },
        {
          label: "Limite Ansiedade",
          data: anxietyLimitLine,
          borderColor: "rgba(248,113,113,0.35)",
          borderWidth: 1,
          borderDash: [4, 4],
          tension: 0,
          pointRadius: 0,
          spanGaps: true,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: textColor } },
        tooltip: {
          callbacks: {
            title: (items) => `Dia ${items?.[0]?.label || ""}`,
          },
        },
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: textColor } },
        y: {
          type: "linear",
          position: "left",
          grid: { color: gridColor },
          ticks: { color: textColor },
          suggestedMin: 0,
        },
        y1: {
          type: "linear",
          position: "right",
          grid: { drawOnChartArea: false },
          ticks: { color: textColor },
          min: 0,
          max: 10,
        },
      },
    },
  });
}

/** ============================================================
 * INSIGHTS 2.0 — blocos inteligentes (mobile-first, sem perder dados)
 * ============================================================ */

function isMobile() {
  return window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
}

function sevMeta(sev) {
  // sev: "critical" | "warning" | "ok" | "info"
  const map = {
    critical: {
      badge: "bg-red-500/15 text-red-300 ring-1 ring-red-500/30",
      border: "border-red-500/20",
      icon: "alert-triangle",
      label: "Crítico",
    },
    warning: {
      badge: "bg-yellow-500/15 text-yellow-200 ring-1 ring-yellow-500/30",
      border: "border-yellow-500/20",
      icon: "alert-circle",
      label: "Atenção",
    },
    ok: {
      badge: "bg-green-500/15 text-green-200 ring-1 ring-green-500/30",
      border: "border-green-500/20",
      icon: "check-circle",
      label: "OK",
    },
    info: {
      badge: "bg-sky-500/15 text-sky-200 ring-1 ring-sky-500/30",
      border: "border-white/10",
      icon: "info",
      label: "Info",
    },
  };
  return map[sev] || map.info;
}

function riskToSev(risk) {
  if (risk >= 70) return "critical";
  if (risk >= 40) return "warning";
  return "ok";
}

function makeBlock({ title, sev = "info", open = false, summaryRight = "", items = [] }) {
  const m = sevMeta(sev);

  const itemsHtml = items.length
    ? `<ul class="mt-2 space-y-2 text-sm leading-relaxed">
        ${items
          .map(
            (html) => `
          <li class="flex gap-2">
            <span class="mt-[2px] opacity-70">•</span>
            <span class="min-w-0">${html}</span>
          </li>`
          )
          .join("")}
      </ul>`
    : `<div class="mt-2 text-sm opacity-70">Sem eventos relevantes na janela.</div>`;

  return `
    <details class="glass-panel p-3 rounded-xl border ${m.border} overflow-hidden" ${open ? "open" : ""}>
      <summary class="cursor-pointer list-none flex items-center justify-between gap-2 select-none">
        <div class="flex items-center gap-2 min-w-0">
          <span class="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-white/5 ring-1 ring-white/10">
            <i data-lucide="${m.icon}" class="w-4 h-4"></i>
          </span>
          <div class="min-w-0">
            <div class="font-semibold truncate">${escapeHtml(title)}</div>
            <div class="text-xs opacity-70">${m.label}</div>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          ${summaryRight ? `<span class="text-xs px-2 py-1 rounded-lg ${m.badge}">${summaryRight}</span>` : ""}
          <i data-lucide="chevron-down" class="w-4 h-4 opacity-60"></i>
        </div>
      </summary>

      ${itemsHtml}
    </details>
  `;
}

function renderInsightBlocks(container, blocks) {
  container.classList.toggle("hidden", blocks.length === 0);
  container.innerHTML = `<div class="grid gap-3">${blocks.join("")}</div>`;
  setupLucide();
}

/** ===== Insights inteligentes e acionáveis (Blocos) ===== */
function generateInsights(logs) {
  const container = document.getElementById("insightsContainer");
  if (!container) return;

  // Se existir uma UL antiga no HTML, limpamos para não duplicar.
  const legacyList = document.getElementById("insightsList");
  if (legacyList) legacyList.innerHTML = "";

  const blocks = [];
  const mobile = isMobile();

  // Qualidade do dado (na janela)
  const expectedDays = KPI_DAYS;
  const recordedDays = logs.length;
  const missing = expectedDays - recordedDays;

  // Base de qualidade
  const qualityItems = [];
  if (missing > 0) {
    qualityItems.push(
      `🧾 <b>Faltam registros:</b> ${missing} dia(s) na última semana. Sem dado, até o Snix vira vidente (e ele não é).`
    );
  } else {
    qualityItems.push(`🧾 <b>Registro consistente:</b> ${recordedDays}/${expectedDays} dias na última semana.`);
  }

  // Poucos dados: não inventa tendência/correlação
  if (logs.length < 3) {
    qualityItems.push("📌 Registre mais dias para análises de tendência (mínimo: 3 registros).");

    blocks.push(
      makeBlock({
        title: "Qualidade do dado",
        sev: missing > 0 ? "warning" : "info",
        open: !mobile,
        summaryRight: `${recordedDays}/${expectedDays} dias`,
        items: qualityItems,
      })
    );

    renderInsightBlocks(container, blocks);
    return;
  }

  const ordered = [...logs].sort((a, b) => new Date(a.date) - new Date(b.date));

  // Vetores
  const sleepV = ordered.map((l) => Number(l.sleep));
  const moodV = ordered.map((l) => Number(l.mood));
  const anxV = ordered.map((l) => Number(l.anxiety));
  const trainedV = ordered.map((l) => (l.trained ? 1 : 0));
  const sleepQualV = ordered.map((l) => Number(l.sleepQual));
  const foodV = ordered.map((l) => Number(l.foodScore));

  const avgSleep = mean(sleepV);
  const avgMood = mean(moodV);
  const avgAnx = mean(anxV);
  const sdAnx = stdev(anxV);

  const limit = Number(appData.goals.anxietyMax);
  const sleepMin = Number(appData.goals.sleepMin);

  // Picos e dias acima
  let peakAnx = -1,
    peakDate = "";
  let highDays = 0;
  for (const l of ordered) {
    const a = Number(l.anxiety);
    if (a > limit) highDays++;
    if (a > peakAnx) {
      peakAnx = a;
      peakDate = l.date;
    }
  }

  // Melhor/pior dia (pela ansiedade; desempate por humor)
  const worst = ordered.reduce((w, l) => {
    if (!w) return l;
    if (Number(l.anxiety) > Number(w.anxiety)) return l;
    if (Number(l.anxiety) === Number(w.anxiety) && Number(l.mood) < Number(w.mood)) return l;
    return w;
  }, null);

  const best = ordered.reduce((b, l) => {
    if (!b) return l;
    if (Number(l.anxiety) < Number(b.anxiety)) return l;
    if (Number(l.anxiety) === Number(b.anxiety) && Number(l.mood) > Number(b.mood)) return l;
    return b;
  }, null);

  // Tendência 3 vs 3
  let trends = null;
  if (ordered.length >= 6) {
    const last3 = ordered.slice(-3);
    const prev3 = ordered.slice(-6, -3);
    const meanKey = (arr, key) => arr.reduce((s, x) => s + Number(x[key]), 0) / arr.length;

    const anxLast = meanKey(last3, "anxiety");
    const anxPrev = meanKey(prev3, "anxiety");
    const moodLast = meanKey(last3, "mood");
    const moodPrev = meanKey(prev3, "mood");
    const sleepLast = meanKey(last3, "sleep");
    const sleepPrev = meanKey(prev3, "sleep");

    trends = {
      anxDelta: anxLast - anxPrev,
      moodDelta: moodLast - moodPrev,
      sleepDelta: sleepLast - sleepPrev,
      anxLast,
      anxPrev,
      moodLast,
      moodPrev,
      sleepLast,
      sleepPrev,
    };
  }

  // Relações (correlações) — sinal e utilidade (não vende causalidade)
  const corrSleepAnx = pearson(sleepV, anxV);
  const corrTrainAnx = pearson(trainedV, anxV);
  const corrSleepQualAnx = pearson(sleepQualV, anxV);
  const corrFoodAnx = pearson(foodV, anxV);

  // Treino vs não-treino (diferença de médias)
  const anxTrain = [];
  const anxNoTrain = [];
  for (const l of ordered) {
    (l.trained ? anxTrain : anxNoTrain).push(Number(l.anxiety));
  }
  const avgTrain = anxTrain.length ? mean(anxTrain) : null;
  const avgNoTrain = anxNoTrain.length ? mean(anxNoTrain) : null;
  const deltaTrain = avgTrain !== null && avgNoTrain !== null ? avgNoTrain - avgTrain : null;

  // Score de risco (heurístico e explicável)
  // 0..100: maior = risco de ansiedade alta amanhã
  let risk = 0;
  const last = ordered[ordered.length - 1];

  // fatores:
  risk += clamp((Number(last.anxiety) - limit) * 10, 0, 35); // ansiedade recente alta
  risk += clamp((sleepMin - Number(last.sleep)) * 8, 0, 25); // sono recente baixo
  if (trends && trends.anxDelta > 0.6) risk += 15; // tendência ruim
  if (sdAnx !== null && sdAnx >= 2.0) risk += 10; // instabilidade
  risk += clamp(noteKeywordsScore(last.notes) * 4, 0, 15); // notas com sinais de estressor

  risk = clamp(Math.round(risk), 0, 100);
  const riskLabel = risk >= 70 ? "alto" : risk >= 40 ? "moderado" : "baixo";

  /** ===== BLOCO 1: ALERTAS (prioridade máxima) ===== */
  const alertItems = [];

  if (highDays >= 2) {
    alertItems.push(
      `🧠 <b>Ansiedade em alerta:</b> ${highDays} dia(s) acima do limite (${limit}) na última semana. Pico ${peakAnx}/10 em ${formatDM(peakDate)}.`
    );
  } else if (avgAnx > limit) {
    alertItems.push(`🧠 <b>Ansiedade acima da meta:</b> média ${avgAnx.toFixed(1)}/10 (limite ${limit}).`);
  } else {
    alertItems.push(`🧘 <b>Ansiedade sob controle:</b> média ${avgAnx.toFixed(1)}/10 (limite ${limit}).`);
  }

  alertItems.push(
    `🎯 <b>Risco para amanhã:</b> ${risk}/100 (${riskLabel}). Base: ansiedade ${last.anxiety}/10, sono ${Number(last.sleep).toFixed(1)}h e tendência recente.`
  );

  if (sdAnx !== null && sdAnx >= 2.0) {
    alertItems.push(`🧨 <b>Instabilidade:</b> desvio padrão da ansiedade ${sdAnx.toFixed(1)} (oscila muito).`);
  }

  // Melhor/pior dia + “gatilho candidato”
  if (best && worst) {
    alertItems.push(
      `🏅 <b>Melhor dia:</b> ${formatDM(best.date)} (ans ${best.anxiety}/10, humor ${best.mood}/10, sono ${Number(best.sleep).toFixed(1)}h).`
    );
    alertItems.push(
      `🧯 <b>Pior dia:</b> ${formatDM(worst.date)} (ans ${worst.anxiety}/10, humor ${worst.mood}/10, sono ${Number(worst.sleep).toFixed(1)}h).`
    );
    const ds = (Number(best.sleep) - Number(worst.sleep)).toFixed(1);
    const da = (Number(worst.anxiety) - Number(best.anxiety)).toFixed(1);
    alertItems.push(`🧩 <b>Candidato a gatilho:</b> do melhor→pior, sono caiu ${ds}h e ansiedade subiu ${da} ponto(s).`);
  }

  blocks.push(
    makeBlock({
      title: "Alertas e risco",
      sev: riskToSev(risk),
      open: true, // sempre abre (principal)
      summaryRight: `Risco ${risk}/100`,
      items: alertItems,
    })
  );

  /** ===== BLOCO 2: TENDÊNCIAS ===== */
  const trendItems = [];
  if (trends) {
    if (trends.anxDelta >= 0.8) {
      trendItems.push(
        `📈 <b>Ansiedade subindo:</b> últ.3d ${trends.anxLast.toFixed(1)} vs ant.3d ${trends.anxPrev.toFixed(1)} (Δ +${trends.anxDelta.toFixed(1)}).`
      );
    } else if (trends.anxDelta <= -0.8) {
      trendItems.push(
        `📉 <b>Ansiedade caindo:</b> últ.3d ${trends.anxLast.toFixed(1)} vs ant.3d ${trends.anxPrev.toFixed(1)} (Δ ${trends.anxDelta.toFixed(1)}).`
      );
    } else {
      trendItems.push(
        `➖ <b>Ansiedade estável:</b> últ.3d ${trends.anxLast.toFixed(1)} vs ant.3d ${trends.anxPrev.toFixed(1)} (Δ ${trends.anxDelta.toFixed(1)}).`
      );
    }

    if (trends.sleepDelta <= -0.6) trendItems.push(`🛌 <b>Sono piorou:</b> Δ ${trends.sleepDelta.toFixed(1)}h nos últimos 3 dias.`);
    else if (trends.sleepDelta >= 0.6) trendItems.push(`🌙 <b>Sono melhorou:</b> Δ +${trends.sleepDelta.toFixed(1)}h nos últimos 3 dias.`);
    else trendItems.push(`🌙 <b>Sono estável:</b> Δ ${trends.sleepDelta.toFixed(1)}h (3 dias).`);

    if (trends.moodDelta <= -0.8)
      trendItems.push(
        `🙂 <b>Humor caiu:</b> últ.3d ${trends.moodLast.toFixed(1)} vs ant.3d ${trends.moodPrev.toFixed(1)} (Δ ${trends.moodDelta.toFixed(1)}).`
      );
    else if (trends.moodDelta >= 0.8)
      trendItems.push(
        `🙂 <b>Humor subiu:</b> últ.3d ${trends.moodLast.toFixed(1)} vs ant.3d ${trends.moodPrev.toFixed(1)} (Δ +${trends.moodDelta.toFixed(1)}).`
      );
    else
      trendItems.push(
        `🙂 <b>Humor estável:</b> últ.3d ${trends.moodLast.toFixed(1)} vs ant.3d ${trends.moodPrev.toFixed(1)} (Δ ${trends.moodDelta.toFixed(1)}).`
      );
  } else {
    trendItems.push("📌 Tendência 3×3 requer pelo menos 6 registros na janela.");
  }

  blocks.push(
    makeBlock({
      title: "Tendências (curto prazo)",
      sev: trends && trends.anxDelta >= 0.8 ? "warning" : "info",
      open: !mobile, // no mobile fecha por padrão
      summaryRight: trends ? `Δ anx ${trends.anxDelta.toFixed(1)}` : "Sem 6 dias",
      items: trendItems,
    })
  );

  /** ===== BLOCO 3: RELAÇÕES PROVÁVEIS ===== */
  const relItems = [];

  if (corrSleepAnx !== null) {
    const sign =
      corrSleepAnx <= -0.25 ? "provável proteção" : corrSleepAnx >= 0.25 ? "pode estar associado" : "fraco";
    relItems.push(
      `🔎 <b>Sono × Ansiedade:</b> correlação ${corrSleepAnx.toFixed(2)} (${sign}). Se o sono cair, observe se a ansiedade sobe no dia seguinte.`
    );
  } else {
    relItems.push("🔎 <b>Sono × Ansiedade:</b> dados insuficientes para correlação (mínimo 4 pontos).");
  }

  if (corrSleepQualAnx !== null && Math.abs(corrSleepQualAnx) >= 0.25) {
    relItems.push(
      `🛏️ <b>Qualidade do sono × Ansiedade:</b> correlação ${corrSleepQualAnx.toFixed(2)}. Não é só horas; sua nota do sono importa.`
    );
  }

  if (corrFoodAnx !== null && Math.abs(corrFoodAnx) >= 0.25) {
    relItems.push(
      `🥗 <b>Alimentação × Ansiedade:</b> correlação ${corrFoodAnx.toFixed(2)}. Quando o foodScore cai, monitore a ansiedade.`
    );
  }

  if (corrTrainAnx !== null) {
    relItems.push(
      `💪 <b>Treino × Ansiedade (correlação):</b> ${corrTrainAnx.toFixed(2)}. Interpretação: sinal fraco não prova nada; serve como pista.`
    );
  }

  if (deltaTrain !== null) {
    if (deltaTrain >= 0.8) {
      relItems.push(
        `✅ <b>Treino parece ajudar:</b> ansiedade com treino ${avgTrain.toFixed(1)} vs sem treino ${avgNoTrain.toFixed(1)} (Δ ${deltaTrain.toFixed(1)}).`
      );
    } else if (deltaTrain <= -0.8) {
      relItems.push(
        `⚠️ <b>Treino pode estar vindo pesado/tarde:</b> com treino ${avgTrain.toFixed(1)} vs sem ${avgNoTrain.toFixed(1)} (Δ ${deltaTrain.toFixed(1)}). Tente treino leve e mais cedo.`
      );
    } else {
      relItems.push(
        `➖ <b>Treino × Ansiedade:</b> efeito pequeno (com ${avgTrain.toFixed(1)} vs sem ${avgNoTrain.toFixed(1)}).`
      );
    }
  } else {
    const trainedCount = trainedV.reduce((s, x) => s + x, 0);
    relItems.push(`💪 <b>Treino:</b> ${trainedCount} registro(s) com treino na janela.`);
  }

  blocks.push(
    makeBlock({
      title: "Relações prováveis (sem causalidade)",
      sev: "info",
      open: !mobile,
      summaryRight: corrSleepAnx !== null ? `r sono×ans ${corrSleepAnx.toFixed(2)}` : "r n/a",
      items: relItems,
    })
  );

  /** ===== BLOCO 4: PLANOS ===== */
  const planItems = [];

  const plan24 = buildPlan24h({ last, risk, limit, sleepMin });
  planItems.push(`🗓️ <b>Plano 24h (mínimo viável):</b> ${plan24}`);

  if (risk >= 40) {
    const plan7 = buildPlan7d({ avgSleep, avgAnx, limit, sleepMin, deltaTrain });
    planItems.push(`📆 <b>Plano 7 dias (curto e realista):</b> ${plan7}`);
  } else {
    planItems.push(`📆 <b>Plano 7 dias:</b> manutenção (rotina de sono + movimento leve). Sem drama: consistência vence intensidade.`);
  }

  planItems.push(
    `📌 <b>Resumo (7d):</b> sono ${avgSleep.toFixed(1)}h | humor ${avgMood.toFixed(1)}/10 | ansiedade ${avgAnx.toFixed(1)}/10.`
  );

  blocks.push(
    makeBlock({
      title: "Planos acionáveis",
      sev: riskToSev(risk),
      open: !mobile,
      summaryRight: risk >= 40 ? "Intervenção" : "Manutenção",
      items: planItems,
    })
  );

  /** ===== BLOCO 5: QUALIDADE DO DADO ===== */
  const qualitySev = missing > 0 ? "warning" : "ok";
  const extraQuality = [];

  // Pequeno “diagnóstico” do dado: variabilidade + lacunas
  if (sdAnx !== null) extraQuality.push(`📊 <b>Variabilidade:</b> desvio padrão da ansiedade ${sdAnx.toFixed(1)}.`);
  extraQuality.push(`🧷 <b>Janela analisada:</b> últimos ${KPI_DAYS} dias.`);

  blocks.push(
    makeBlock({
      title: "Qualidade do dado",
      sev: qualitySev,
      open: !mobile,
      summaryRight: `${recordedDays}/${expectedDays} dias`,
      items: [...qualityItems, ...extraQuality],
    })
  );

  renderInsightBlocks(container, blocks);
}

function buildPlan24h({ last, risk, limit, sleepMin }) {
  const steps = [];

  // sono
  if (Number(last.sleep) < sleepMin) steps.push("priorize dormir no horário (meta: +45min hoje)");
  else steps.push("mantenha rotina de sono (sem heroísmo)");

  // ansiedade
  if (Number(last.anxiety) > limit || risk >= 70) {
    steps.push("2 blocos de respiração 4-6 (2 min cada)");
    steps.push("corte cafeína após 15h (se usar)");
  } else if (risk >= 40) {
    steps.push("1 bloco de respiração 4-6 (2 min)");
  } else {
    steps.push("check-in rápido de 1 min antes de dormir");
  }

  // treino leve se útil
  if (!last.trained && risk >= 40) steps.push("caminhada leve 10–15 min (manhã/tarde)");

  // registro
  steps.push("registre o dia (leva 60s, salva sua análise)");

  return steps.join("; ") + ".";
}

function buildPlan7d({ avgSleep, avgAnx, limit, sleepMin, deltaTrain }) {
  const steps = [];

  // Sono como base
  if (avgSleep < sleepMin) steps.push("fixe horário de sono por 7 dias (±30 min)");
  else steps.push("proteja seu sono: sem tela 30 min antes");

  // Treino como alavanca
  if (deltaTrain !== null && deltaTrain >= 0.8) {
    steps.push("treino leve 3x/semana (10–20 min) porque seu dado sugere efeito positivo");
  } else {
    steps.push("movimento 3x/semana (mesmo que leve) para estabilizar humor/ansiedade");
  }

  // Ansiedade
  if (avgAnx > limit) steps.push("protocolo diário: 1 técnica curta (2–5 min) + revisão de gatilhos");
  else steps.push("manter protocolo “manutenção”: 3x na semana");

  // Dados
  steps.push("registro diário (sem lacuna) para reduzir viés e melhorar decisões");

  return steps.join("; ") + ".";
}

/** History */
function renderHistory() {
  const container = document.getElementById("historyList");
  if (!container) return;
  container.innerHTML = "";

  const displayLogs = appData.logs.slice(0, 14);

  displayLogs.forEach((log) => {
    const dateFmt = formatDM(log.date);

    const div = document.createElement("div");
    // Ajuste leve: melhora quebra no mobile sem mudar seus dados
    div.className =
      "glass-panel p-3 rounded-lg flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 text-sm group";
    div.innerHTML = `
      <div class="flex items-start gap-3 min-w-0">
        <div class="font-mono font-bold opacity-60 shrink-0">${dateFmt}</div>
        <div class="min-w-0">
          <div class="flex gap-2 text-xs flex-wrap">
            <span class="${Number(log.sleep) >= appData.goals.sleepMin ? "text-green-400" : "text-red-400"} flex items-center gap-1">
              <i data-lucide="moon" class="w-3 h-3"></i> ${Number(log.sleep).toFixed(1)}h
            </span>
            <span class="${log.trained ? "text-[var(--accent)]" : "opacity-40"} flex items-center gap-1">
              <i data-lucide="dumbbell" class="w-3 h-3"></i> ${log.trained ? "Sim" : "Não"}${log.trained && log.trainMin ? ` (${log.trainMin}m)` : ""}
            </span>
            <span class="opacity-70 flex items-center gap-1">
              <i data-lucide="smile" class="w-3 h-3"></i> ${Number(log.mood)}/10
            </span>
            <span class="${Number(log.anxiety) > appData.goals.anxietyMax ? "text-red-400" : "opacity-70"} flex items-center gap-1">
              <i data-lucide="alert-triangle" class="w-3 h-3"></i> ${Number(log.anxiety)}/10
            </span>
          </div>
          ${
            log.notes
              ? `<div class="text-xs opacity-60 mt-1 line-clamp-2 break-words">${escapeHtml(log.notes).slice(0, 160)}</div>`
              : ""
          }
        </div>
      </div>

      <div class="flex items-center justify-end gap-3">
        <button onclick="deleteLog('${log.date}')" class="p-2 text-red-400 hover:bg-white/10 rounded transition sm:opacity-0 sm:group-hover:opacity-100" title="Excluir">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `;
    container.appendChild(div);
  });

  setupLucide();
}

/** Toggle history */
function toggleHistory() {
  const list = document.getElementById("historyList");
  list && list.classList.toggle("hidden");
}

// ============================================================
// Modais / Interação
// ============================================================
function openLogModal() {
  document.getElementById("logModal")?.classList.add("active");
}
function closeLogModal() {
  document.getElementById("logModal")?.classList.remove("active");
  document.getElementById("logForm")?.reset();
  document.getElementById("trainDetails")?.classList.add("hidden");

  const dateInput = document.getElementById("inputDate");
  if (dateInput) dateInput.valueAsDate = new Date();
}

function toggleTrainInputs() {
  const isChecked = document.getElementById("inputTrainDone")?.checked;
  const details = document.getElementById("trainDetails");
  if (!details) return;
  details.classList.toggle("hidden", !isChecked);
}

function setTrainType(type) {
  const input = document.getElementById("inputTrainType");
  if (input) input.value = type;

  document.querySelectorAll(".train-type-btn").forEach((b) => {
    if (b.innerText === type) b.classList.add("bg-[var(--accent)]", "text-white");
    else b.classList.remove("bg-[var(--accent)]", "text-white");
  });
}

function updateRangeVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.innerText = val;
}

// ============================================================
// Persistência: salvar/deletar logs (local + backend)
// ============================================================
async function saveLog(e) {
  e.preventDefault();

  const newLog = {
    date: document.getElementById("inputDate").value,
    sleep: Number(document.getElementById("inputSleep").value),
    sleepQual: Number(document.getElementById("inputSleepQual").value),
    trained: document.getElementById("inputTrainDone").checked,
    trainMin: Number(document.getElementById("inputTrainMin").value || 0),
    trainType: document.getElementById("inputTrainType").value || "",
    foodScore: Number(document.getElementById("inputFoodScore").value),
    water: document.getElementById("inputWater").checked,
    meals: document.getElementById("inputMeals").checked,
    mood: Number(document.getElementById("inputMood").value),
    anxiety: Number(document.getElementById("inputAnxiety").value),
    notes: document.getElementById("inputNotes").value || "",
  };

  // Atualiza local primeiro
  appData.logs = appData.logs.filter((l) => l.date !== newLog.date);
  appData.logs.push(newLog);
  saveLocal();

  renderDashboard();
  closeLogModal();

  // Backend
  try {
    await api("/logs", { method: "POST", body: newLog });
    const remote = await api("/state");
    appData = normalizeData(remote);
    saveLocal();
    renderDashboard();
  } catch (err) {
    console.warn("Falha ao salvar no backend; ficou apenas local.", err);
  }
}

async function deleteLog(date) {
  if (!confirm("Excluir registro de " + date + "?")) return;

  // Local primeiro
  appData.logs = appData.logs.filter((l) => l.date !== date);
  saveLocal();
  renderDashboard();

  // Backend
  try {
    await api(`/logs/${date}`, { method: "DELETE" });
    const remote = await api("/state");
    appData = normalizeData(remote);
    saveLocal();
    renderDashboard();
  } catch (err) {
    console.warn("Falha ao deletar no backend; deletou apenas local.", err);
  }
}

// ============================================================
// Settings / Tema (local + backend)
// ============================================================
function openSettings() {
  document.getElementById("settingsModal")?.classList.add("active");
}
function closeSettings() {
  document.getElementById("settingsModal")?.classList.remove("active");
}

async function saveSettings() {
  appData.goals.sleepMin = parseFloat(document.getElementById("goalSleep").value);
  appData.goals.workoutsPerWeek = parseInt(document.getElementById("goalWorkout").value);
  appData.goals.anxietyMax = parseInt(document.getElementById("goalAnxiety").value);
  appData.goals.foodTarget = Number(appData.goals.foodTarget ?? DEFAULT_GOALS.foodTarget);

  saveLocal();
  renderDashboard();
  closeSettings();

  try {
    await api("/settings", { method: "PUT", body: { goals: appData.goals, theme: appData.theme } });
  } catch (err) {
    console.warn("Falha ao salvar settings no backend; ficou local.", err);
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

async function toggleTheme() {
  appData.theme = appData.theme === "dark" ? "light" : "dark";
  applyTheme(appData.theme);
  saveLocal();
  renderDashboard();

  try {
    await api("/settings", { method: "PUT", body: { goals: appData.goals, theme: appData.theme } });
  } catch (err) {
    console.warn("Falha ao salvar tema no backend; ficou local.", err);
  }
}

// ============================================================
// Backup JSON
// ============================================================
function downloadJSON() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appData));
  const a = document.createElement("a");
  a.setAttribute("href", dataStr);
  a.setAttribute("download", "lifeops_backup.json");
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function uploadJSON(input) {
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const parsed = normalizeData(JSON.parse(e.target.result));
      appData = parsed;
      saveLocal();
      renderDashboard();
      alert("Dados importados com sucesso!");
      closeSettings();
    } catch {
      alert("Erro ao ler arquivo JSON.");
    }
  };
  reader.readAsText(file);
}

// ============================================================
// Configurar URL do backend
// ============================================================
function configureBackend() {
  const current = getApiBase();
  const url = prompt("URL do backend (ex: http://127.0.0.1:8000 ou https://seu-dominio)", current);
  if (!url) return;

  const cleaned = url.trim().replace(/\/+$/, "");
  setApiBase(cleaned);
  updateBackendLabel();

  loadData()
    .then(() => {
      setupLucide();
      renderDashboard();
      alert("Backend atualizado: " + cleaned);
    })
    .catch(() => {
      alert("Backend atualizado, mas não consegui conectar agora.");
    });
}

// ============================================================
// PDF
// ============================================================
function generatePDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const monthInput = document.getElementById("reportMonth").value; // YYYY-MM
  if (!monthInput) return alert("Selecione um mês para o relatório.");

  const reportLogs = appData.logs
    .filter((l) => l.date.startsWith(monthInput))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!reportLogs.length) return alert("Nenhum registro encontrado para este mês.");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(40, 40, 40);
  doc.text("LifeOps | Relatório Mensal", 14, 20);

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(`Período: ${monthInput}`, 14, 26);

  const avgSleep = (reportLogs.reduce((a, b) => a + Number(b.sleep), 0) / reportLogs.length).toFixed(1);
  const totalWorkouts = reportLogs.filter((l) => l.trained).length;
  const avgMood = (reportLogs.reduce((a, b) => a + Number(b.mood), 0) / reportLogs.length).toFixed(1);
  const avgAnx = (reportLogs.reduce((a, b) => a + Number(b.anxiety), 0) / reportLogs.length).toFixed(1);

  doc.setDrawColor(200, 200, 200);
  doc.line(14, 30, 196, 30);

  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  doc.text(`Sono: ${avgSleep}h`, 14, 38);
  doc.text(`Treinos: ${totalWorkouts}`, 70, 38);
  doc.text(`Humor: ${avgMood}/10`, 120, 38);
  doc.text(`Ansiedade: ${avgAnx}/10`, 160, 38);

  const tableData = reportLogs.map((log) => [
    formatDM(log.date),
    Number(log.sleep).toFixed(1) + "h",
    log.trained ? (log.trainType || "Sim") : "-",
    Number(log.foodScore) + "/5",
    Number(log.mood),
    Number(log.anxiety),
  ]);

  doc.autoTable({
    startY: 45,
    head: [["Data", "Sono", "Treino", "Alim.", "Humor", "Ans."]],
    body: tableData,
    theme: "grid",
    headStyles: { fillColor: [56, 189, 248] },
    styles: { fontSize: 9, cellPadding: 3 },
  });

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text("Gerado via LifeOps Personal Dashboard", 14, doc.internal.pageSize.height - 10);
  }

  doc.save(`LifeOps_Relatorio_${monthInput}.pdf`);
}

// ============================================================
// Snix (Coach IA)
// ============================================================
let _snixLastRun = 0;

function openSnix() {
  document.getElementById("snixModal")?.classList.add("active");
  setupLucide();
}
function closeSnix() {
  document.getElementById("snixModal")?.classList.remove("active");
}

function setSnixStatus(msg, show = true) {
  const el = document.getElementById("snixStatus");
  if (!el) return;
  if (!show) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.textContent = msg;
}

function renderSnixMeta(res) {
  const metaEl = document.getElementById("snixMeta");
  if (!metaEl) return;

  const stats = res?.stats || {};
  const model = res?.model || "—";
  const used = res?.n_logs_used ?? "—";
  const start = stats?.window_start_selected || stats?.window_start || "—";
  const end = stats?.window_end_selected || stats?.window_end || "—";
  const peak = stats?.peak_anxiety ?? "—";
  const peakDate = stats?.peak_date ? formatDM(stats.peak_date) : "—";
  const high = stats?.high_anxiety_days ?? "—";
  const avgAnx = stats?.avg_anxiety ?? "—";
  const avgSleep = stats?.avg_sleep ?? "—";
  const cacheKey = stats?.cache_key ? ` | cache` : "";

  metaEl.innerHTML = `
    <div class="text-xs opacity-70 leading-relaxed">
      <b>Modelo:</b> ${escapeHtml(model)}${cacheKey}<br/>
      <b>Janela:</b> ${escapeHtml(start)} → ${escapeHtml(end)} | <b>logs:</b> ${escapeHtml(used)}<br/>
      <b>Avg sono:</b> ${escapeHtml(String(avgSleep))}h | <b>Avg ansiedade:</b> ${escapeHtml(String(avgAnx))}/10 | <b>Acima limite:</b> ${escapeHtml(String(high))}<br/>
      <b>Pico:</b> ${escapeHtml(String(peak))}/10 em ${escapeHtml(peakDate)}
    </div>
  `;
}

async function runSnix() {
  const out = document.getElementById("snixOutput");
  const days = Number(document.getElementById("snixDays")?.value || 14);

  if (!out) return;

  const now = Date.now();
  if (now - _snixLastRun < SNIX_COOLDOWN_MS) {
    setSnixStatus("Calma. Um Snix por vez.", true);
    return;
  }
  _snixLastRun = now;

  try {
    setSnixStatus("Snix está analisando... sem drama, só evidência.", true);
    out.textContent = "";

    const res = await api("/coach/snix", {
      method: "POST",
      body: { days },
      timeoutMs: SNIX_TIMEOUT_MS,
    });

    const report = res?.report || "Sem resposta do Snix.";
    out.textContent = report;

    renderSnixMeta(res);

    if (String(res?.model || "").includes("offline")) {
      setSnixStatus("Modo offline (quota/limite). Mesmo assim: útil e acionável.", true);
    } else {
      setSnixStatus("Pronto. Agora executa.", true);
    }
  } catch (e) {
    setSnixStatus("Falha ao rodar Snix. Veja backend (.env, quota, modelo, chave).", true);
    out.textContent = String(e?.message || e);
  }
}

window.runSnix = runSnix;

// ============================================================
// Expor funções no window
// ============================================================
window.toggleTheme = toggleTheme;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.saveSettings = saveSettings;
window.toggleHistory = toggleHistory;

window.openLogModal = openLogModal;
window.closeLogModal = closeLogModal;
window.toggleTrainInputs = toggleTrainInputs;
window.setTrainType = setTrainType;
window.updateRangeVal = updateRangeVal;

window.saveLog = saveLog;
window.deleteLog = deleteLog;

window.downloadJSON = downloadJSON;
window.uploadJSON = uploadJSON;

window.generatePDF = generatePDF;
window.configureBackend = configureBackend;

window.openSnix = openSnix;
window.closeSnix = closeSnix;
window.runSnix = runSnix;

// (Opcional) alterar modo do gráfico:
window.setChartMode = (mode) => {
  chartMode = mode === "rolling" ? "rolling" : "month";
  renderDashboard();
};

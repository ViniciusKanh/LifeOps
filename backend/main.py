"""
LifeOps API — FastAPI + Turso (libSQL) via Embedded Replica + Gemini Coach (Snix)

- Persistência local: SQLite (DB_FILE)
- Sync opcional: Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)
- Endpoints: /state, /logs, /settings, /health, /llm/models
- Coach IA (Snix): POST /coach/snix (Gemini via .env), com cache + retry + fallback

Requisitos:
- fastapi, uvicorn[standard], libsql, pydantic, python-dotenv
"""

import os
import json
import threading
import time
import random
from typing import Any, Dict, Optional, List, Tuple
from datetime import datetime, date, timedelta

import libsql
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ConfigDict

from urllib import request as urlrequest
from urllib.error import URLError, HTTPError

# ============================================================
# Carrega .env
# ============================================================
load_dotenv()

# ============================================================
# Config DB/Turso
# ============================================================
DB_FILE = os.getenv("DB_FILE", "./data/lifeops.db")
TURSO_URL = os.getenv("TURSO_DATABASE_URL")
TURSO_TOKEN = os.getenv("TURSO_AUTH_TOKEN")

DEFAULT_GOALS = {
    "sleepMin": 7.0,
    "workoutsPerWeek": 3,
    "foodTarget": 4,
    "anxietyMax": 6,
}

# ============================================================
# Config Gemini
# ============================================================
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
GEMINI_BASE_URL = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").strip()

# Resiliência LLM
SNIX_CACHE_TTL_SEC = int(os.getenv("SNIX_CACHE_TTL_SEC", "900"))  # 15 min
SNIX_RETRIES = int(os.getenv("SNIX_RETRIES", "3"))               # tentativas em 429/5xx
SNIX_BACKOFF_BASE = float(os.getenv("SNIX_BACKOFF_BASE", "0.8")) # base do backoff
SNIX_BACKOFF_CAP = float(os.getenv("SNIX_BACKOFF_CAP", "8.0"))   # teto do backoff
SNIX_MAX_OUTPUT_TOKENS = int(os.getenv("SNIX_MAX_OUTPUT_TOKENS", "800"))

# ============================================================
# App
# ============================================================
app = FastAPI(title="LifeOps API", version="1.2.3")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # DEV ok. Produção: restrinja.
    allow_methods=["*"],
    allow_headers=["*"],
)

_conn: Optional[libsql.Connection] = None
_lock = threading.Lock()

# Cache simples em memória (por processo)
_snix_cache_lock = threading.Lock()
_snix_cache: Dict[str, Dict[str, Any]] = {}  # key -> {"ts": float, "value": SnixCoachOut dict}


# ============================================================
# Helpers DB
# ============================================================
def _ensure_db_dir() -> None:
    db_dir = os.path.dirname(DB_FILE)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)


def _connect() -> libsql.Connection:
    _ensure_db_dir()
    if TURSO_URL and TURSO_TOKEN:
        return libsql.connect(DB_FILE, sync_url=TURSO_URL, auth_token=TURSO_TOKEN)
    return libsql.connect(DB_FILE)


def _sync(conn: libsql.Connection) -> None:
    if TURSO_URL and TURSO_TOKEN:
        conn.sync()


def _init_schema(conn: libsql.Connection) -> None:
    conn.execute("""
    CREATE TABLE IF NOT EXISTS logs (
      date TEXT PRIMARY KEY,
      sleep REAL NOT NULL,
      sleepQual INTEGER NOT NULL,
      trained INTEGER NOT NULL,
      trainMin INTEGER NOT NULL,
      trainType TEXT,
      foodScore INTEGER NOT NULL,
      water INTEGER NOT NULL,
      meals INTEGER NOT NULL,
      mood INTEGER NOT NULL,
      anxiety INTEGER NOT NULL,
      notes TEXT
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      goals_json TEXT NOT NULL,
      theme TEXT NOT NULL
    );
    """)

    conn.execute(
        "INSERT OR IGNORE INTO state (id, goals_json, theme) VALUES (1, ?, ?);",
        (json.dumps(DEFAULT_GOALS), "dark"),
    )
    conn.commit()


def _require_conn() -> libsql.Connection:
    global _conn
    if _conn is None:
        _conn = _connect()
        with _lock:
            _init_schema(_conn)
            _sync(_conn)
    return _conn


def _bool_to_int(v: bool) -> int:
    return 1 if v else 0


def _row_to_log(r) -> Dict[str, Any]:
    return {
        "date": r[0],
        "sleep": float(r[1]),
        "sleepQual": int(r[2]),
        "trained": bool(r[3]),
        "trainMin": int(r[4]),
        "trainType": r[5] or "",
        "foodScore": int(r[6]),
        "water": bool(r[7]),
        "meals": bool(r[8]),
        "mood": int(r[9]),
        "anxiety": int(r[10]),
        "notes": r[11] or "",
    }


def _merge_goals(goals: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    g = {**DEFAULT_GOALS, **(goals or {})}

    def as_int(x, default):
        try:
            return int(x)
        except Exception:
            return default

    def as_float(x, default):
        try:
            return float(x)
        except Exception:
            return default

    return {
        "sleepMin": as_float(g.get("sleepMin"), DEFAULT_GOALS["sleepMin"]),
        "workoutsPerWeek": as_int(g.get("workoutsPerWeek"), DEFAULT_GOALS["workoutsPerWeek"]),
        "foodTarget": as_int(g.get("foodTarget"), DEFAULT_GOALS["foodTarget"]),
        "anxietyMax": as_int(g.get("anxietyMax"), DEFAULT_GOALS["anxietyMax"]),
    }


def _parse_yyyy_mm_dd(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _today_safe() -> date:
    return date.today()


# ============================================================
# Models
# ============================================================
class LogIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    date: str
    sleep: float
    sleepQual: int
    trained: bool
    trainMin: int = 0
    trainType: Optional[str] = None
    foodScore: int
    water: bool
    meals: bool
    mood: int
    anxiety: int
    notes: str = ""


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    goals: Dict[str, Any] = Field(default_factory=dict)
    theme: str = "dark"


class SnixCoachIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    days: int = 14
    max_items: int = 60
    focus: str = "ansiedade"
    include_notes: bool = True


class SnixCoachOut(BaseModel):
    ok: bool
    coach: str
    model: str
    days: int
    n_logs_used: int
    report: str
    stats: Dict[str, Any]


# ============================================================
# Analytics
# ============================================================
def _pearson_corr(xs: List[float], ys: List[float]) -> Optional[float]:
    if len(xs) != len(ys) or len(xs) < 4:
        return None
    n = len(xs)
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    denx = sum((x - mx) ** 2 for x in xs) ** 0.5
    deny = sum((y - my) ** 2 for y in ys) ** 0.5
    if denx == 0 or deny == 0:
        return None
    return num / (denx * deny)


def _summarize_window(goals: Dict[str, Any], logs: List[Dict[str, Any]]) -> Dict[str, Any]:
    n = len(logs)
    anx_limit = int(goals.get("anxietyMax", 6))

    sleep = [float(l.get("sleep", 0) or 0) for l in logs]
    mood = [int(l.get("mood", 0) or 0) for l in logs]
    anx = [int(l.get("anxiety", 0) or 0) for l in logs]
    food = [int(l.get("foodScore", 0) or 0) for l in logs]
    trained = [bool(l.get("trained", False)) for l in logs]

    workouts = sum(1 for t in trained if t)
    high_anx_days = sum(1 for a in anx if a > anx_limit)

    peak_anx = max(anx) if anx else 0
    peak_idx = anx.index(peak_anx) if anx else 0
    peak_date = logs[peak_idx].get("date") if logs else None

    anx_train = [a for a, t in zip(anx, trained) if t]
    anx_not = [a for a, t in zip(anx, trained) if not t]
    train_effect = None
    if anx_train and anx_not:
        train_effect = round((sum(anx_not) / len(anx_not)) - (sum(anx_train) / len(anx_train)), 3)

    corr_sleep_anx = _pearson_corr(sleep, [float(a) for a in anx])
    if corr_sleep_anx is not None:
        corr_sleep_anx = round(corr_sleep_anx, 3)

    dts = [_parse_yyyy_mm_dd(l["date"]) for l in logs]
    start = min(dts) if dts else None
    end = max(dts) if dts else None
    missing = 0
    if start and end:
        have = set(dts)
        cur = start
        while cur <= end:
            if cur not in have:
                missing += 1
            cur += timedelta(days=1)

    trend = {}
    if n >= 6:
        last3 = logs[-3:]
        prev3 = logs[-6:-3]

        def mean(arr, key) -> float:
            return sum(float(x.get(key, 0) or 0) for x in arr) / len(arr)

        trend = {
            "anxiety_delta": round(mean(last3, "anxiety") - mean(prev3, "anxiety"), 2),
            "sleep_delta": round(mean(last3, "sleep") - mean(prev3, "sleep"), 2),
            "mood_delta": round(mean(last3, "mood") - mean(prev3, "mood"), 2),
        }

    return {
        "n": n,
        "window_start": start.isoformat() if start else None,
        "window_end": end.isoformat() if end else None,
        "missing_days_in_range": missing,
        "anxiety_limit": anx_limit,
        "avg_sleep": round(sum(sleep) / n, 2),
        "avg_mood": round(sum(mood) / n, 2),
        "avg_anxiety": round(sum(anx) / n, 2),
        "avg_food": round(sum(food) / n, 2),
        "workouts": workouts,
        "high_anxiety_days": high_anx_days,
        "peak_anxiety": int(peak_anx),
        "peak_date": peak_date,
        "train_effect": train_effect,
        "corr_sleep_vs_anxiety": corr_sleep_anx,
        "trend": trend,
    }


def _select_window_from_logs(logs_desc: List[Dict[str, Any]], days: int) -> Dict[str, Any]:
    today = _today_safe()
    past_or_today, future = [], []

    for l in logs_desc:
        try:
            d = _parse_yyyy_mm_dd(l["date"])
        except Exception:
            continue
        (past_or_today if d <= today else future).append(l)

    base = past_or_today if len(past_or_today) >= 3 else logs_desc
    base_sorted = sorted(base, key=lambda x: x["date"])

    end_date = _parse_yyyy_mm_dd(base_sorted[-1]["date"])
    start_date = end_date - timedelta(days=days - 1)

    window = []
    for l in base_sorted:
        try:
            d = _parse_yyyy_mm_dd(l["date"])
        except Exception:
            continue
        if start_date <= d <= end_date:
            window.append(l)

    return {
        "window": window,
        "future_count": len(future),
        "used_start_date": start_date.isoformat(),
        "used_end_date": end_date.isoformat(),
        "used_past_only": len(past_or_today) >= 3,
    }


# ============================================================
# Cache helpers (Snix)
# ============================================================
def _cache_get(key: str) -> Optional[Dict[str, Any]]:
    now = time.time()
    with _snix_cache_lock:
        item = _snix_cache.get(key)
        if not item:
            return None
        if (now - float(item["ts"])) > SNIX_CACHE_TTL_SEC:
            _snix_cache.pop(key, None)
            return None
        return item["value"]


def _cache_set(key: str, value: Dict[str, Any]) -> None:
    with _snix_cache_lock:
        _snix_cache[key] = {"ts": time.time(), "value": value}


# ============================================================
# Gemini client (com retry em 429/5xx)
# ============================================================
def _validate_gemini_model_name(model: str) -> str:
    m = (model or "").strip()
    if not m:
        raise HTTPException(status_code=503, detail="GEMINI_MODEL vazio. Ex.: gemini-2.5-flash.")

    if m.startswith("models/"):
        m = m[len("models/"):].strip()

    low = m.lower()
    if "llama" in low or "mixtral" in low:
        raise HTTPException(
            status_code=422,
            detail=f"GEMINI_MODEL inválido para Gemini: '{m}'. Use um modelo Gemini (ex.: gemini-2.5-flash).",
        )

    if not low.startswith("gemini-"):
        raise HTTPException(
            status_code=422,
            detail=f"GEMINI_MODEL suspeito: '{m}'. Use um modelo que comece com 'gemini-'.",
        )

    return m


def _gemini_list_models() -> Dict[str, Any]:
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY não configurada no .env.")

    base = (GEMINI_BASE_URL or "").strip().rstrip("/")
    url = f"{base}/models?key={GEMINI_API_KEY}"

    req = urlrequest.Request(url, headers={"Accept": "application/json"}, method="GET")

    try:
        with urlrequest.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw)
    except HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"Gemini ListModels HTTPError: {e.code} {body[:400]}")
    except URLError as e:
        raise HTTPException(status_code=502, detail=f"Gemini ListModels URLError: {str(e)[:200]}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini ListModels erro inesperado: {str(e)[:200]}")


def _gemini_generate_once(
    system_text: str,
    user_text: str,
    model: str,
    temperature: float,
    max_output_tokens: int,
    top_p: float,
) -> Dict[str, Any]:
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY não configurada no .env.")

    model = _validate_gemini_model_name(model)

    base = (GEMINI_BASE_URL or "").strip().rstrip("/")
    url = f"{base}/models/{model}:generateContent?key={GEMINI_API_KEY}"

    payload = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": float(temperature),
            "maxOutputTokens": int(max_output_tokens),
            "topP": float(top_p),
        },
    }

    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "LifeOps/1.2 (FastAPI; SnixCoach)",
        "Connection": "close",
    }

    req = urlrequest.Request(url, data=data, headers=headers, method="POST")

    with urlrequest.urlopen(req, timeout=40) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        j = json.loads(raw)

        prompt_fb = j.get("promptFeedback") or {}
        block_reason = prompt_fb.get("blockReason")

        candidates = j.get("candidates") or []
        text = ""
        finish_reason = None

        if candidates:
            c0 = candidates[0] or {}
            finish_reason = c0.get("finishReason")
            content = c0.get("content") or {}
            parts = content.get("parts") or []
            texts: List[str] = []
            for p in parts:
                if isinstance(p, dict) and p.get("text"):
                    texts.append(str(p["text"]).strip())
            text = "\n".join(t for t in texts if t).strip()

        meta = {
            "block_reason": block_reason,
            "finish_reason": finish_reason,
            "usage": j.get("usageMetadata"),
        }

        return {"text": text, "meta": meta, "raw_head": raw[:300]}


def _gemini_generate(
    system_text: str,
    user_text: str,
    model: str,
    temperature: float = 0.35,
    max_output_tokens: int = 800,
    top_p: float = 0.95,
) -> Dict[str, Any]:
    """
    Retry em:
    - 429 (quota/rate limit)
    - 500/503 (instabilidade)
    """
    last_err: Optional[str] = None

    for attempt in range(SNIX_RETRIES + 1):
        try:
            return _gemini_generate_once(
                system_text=system_text,
                user_text=user_text,
                model=model,
                temperature=temperature,
                max_output_tokens=max_output_tokens,
                top_p=top_p,
            )
        except HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass

            last_err = f"Gemini HTTPError: {e.code} {body[:300]}"

            # Decide se vale retry
            retriable = e.code in (429, 500, 503)
            if not retriable or attempt >= SNIX_RETRIES:
                raise HTTPException(status_code=502, detail=last_err)

        except URLError as e:
            last_err = f"Gemini URLError: {str(e)[:200]}"
            if attempt >= SNIX_RETRIES:
                raise HTTPException(status_code=502, detail=last_err)

        except Exception as e:
            last_err = f"Gemini erro inesperado: {str(e)[:200]}"
            if attempt >= SNIX_RETRIES:
                raise HTTPException(status_code=502, detail=last_err)

        # Backoff exponencial com jitter
        sleep_s = min(SNIX_BACKOFF_CAP, SNIX_BACKOFF_BASE * (2 ** attempt))
        sleep_s += random.uniform(0, 0.25)
        time.sleep(sleep_s)

    raise HTTPException(status_code=502, detail=last_err or "Falha desconhecida no Gemini.")


# ============================================================
# Fallback (sem LLM) — relatório determinístico
# ============================================================
def _snix_fallback_report(stats: Dict[str, Any], focus: str) -> str:
    """
    Retorna um relatório simples, útil e 100% offline.
    Não é “IA”, é engenharia: você não fica na mão do 429.
    """
    focus = (focus or "ansiedade").strip()

    lines = []
    lines.append(f"# Snix (modo offline) — foco: {focus}")
    lines.append("")
    lines.append("## Leitura objetiva")
    lines.append(f"- Janela: {stats.get('window_start')} → {stats.get('window_end')} ({stats.get('n')} registros)")
    lines.append(f"- Sono médio: {stats.get('avg_sleep')}h (meta: {stats.get('sleepMin','?')}h)")
    lines.append(f"- Humor médio: {stats.get('avg_mood')}/10")
    lines.append(f"- Ansiedade média: {stats.get('avg_anxiety')}/10 (limite: {stats.get('anxiety_limit')})")
    lines.append(f"- Dias acima do limite: {stats.get('high_anxiety_days')}")
    lines.append(f"- Pico de ansiedade: {stats.get('peak_anxiety')}/10 em {stats.get('peak_date')}")
    lines.append(f"- Treinos na janela: {stats.get('workouts')}")
    if stats.get("corr_sleep_vs_anxiety") is not None:
        lines.append(f"- Correlação sono×ansiedade: {stats.get('corr_sleep_vs_anxiety')} (sinal, não causalidade)")
    if stats.get("train_effect") is not None:
        lines.append(f"- Efeito treino (heurístico): {stats.get('train_effect')} (positivo sugere treino associado a menor ansiedade)")

    lines.append("")
    lines.append("## Plano mínimo (7 dias)")
    lines.append("- 1) Sono: manter horário fixo de dormir/acordar (±30 min).")
    lines.append("- 2) Treino: 10–20 min em dias alternados (caminhada/força leve).")
    lines.append("- 3) Registro: preencher todos os dias (reduz viés e melhora análise).")

    lines.append("")
    lines.append("## Protocolo rápido (1–5 min)")
    lines.append("- Respiração 4-6 (inspirar 4s, expirar 6s) por 2 min.")
    lines.append("- “Descarrego” mental: anotar 3 preocupações + 1 próxima ação possível (2 min).")
    lines.append("- Alongamento leve de pescoço/ombros (1–2 min).")

    lines.append("")
    lines.append("## 3 métricas para amanhã")
    lines.append("- Horário de dormir e acordar (objetivo: consistência).")
    lines.append("- Ansiedade (0–10) antes de dormir.")
    lines.append("- Treino (sim/não + minutos).")

    lines.append("")
    lines.append("> Nota: Sem quota do Gemini, eu viro estatístico. Quando a cota voltar, eu viro coach de novo.")
    return "\n".join(lines)


# ============================================================
# Prompt do Snix
# ============================================================
def _build_snix_prompt(
    goals: Dict[str, Any],
    window: List[Dict[str, Any]],
    focus: str,
    include_notes: bool,
) -> Tuple[str, str, Dict[str, Any]]:
    compact = []
    for l in window:
        compact.append({
            "date": l["date"],
            "sleep_h": float(l["sleep"]),
            "sleep_qual_1to5": int(l["sleepQual"]),
            "trained": bool(l["trained"]),
            "train_min": int(l.get("trainMin", 0)),
            "train_type": (l.get("trainType") or "")[:20],
            "food_1to5": int(l["foodScore"]),
            "water_ok": bool(l.get("water", False)),
            "meals_ok": bool(l.get("meals", False)),
            "mood_0to10": int(l["mood"]),
            "anxiety_0to10": int(l["anxiety"]),
            "notes": ((l.get("notes") or "")[:200] if include_notes else ""),
        })

    stats = _summarize_window(goals, window)

    system_text = (
        "Você é o Snix, coach de hábitos guiado por dados do LifeOps.\n"
        "Missão: reduzir ansiedade e estabilizar humor com intervenções pequenas, realistas e mensuráveis.\n"
        "Regras:\n"
        "- Não faça diagnóstico médico/psicológico.\n"
        "- Não use linguagem alarmista.\n"
        "- Se perceber ansiedade alta e persistente, recomende conversar com um adulto de confiança e, se possível, um profissional.\n"
        "- Use linguagem direta, objetiva e prática em PT-BR.\n"
        "- Baseie recomendações em stats/padrões e proponha experimentos simples.\n"
        "- Inclua no máximo 1 linha curta de humor sagaz, sem banalizar o tema.\n"
    )

    user_payload = {
        "focus": (focus or "ansiedade")[:40],
        "goals": goals,
        "stats": stats,
        "logs": compact,
        "tarefas": [
            "1) Leitura objetiva dos dados (sem floreio).",
            "2) Padrões e relações prováveis (sono vs ansiedade; treino vs ansiedade).",
            "3) Hipóteses testáveis (máx. 4): 'se eu fizer X, espero Y'.",
            "4) Plano de 7 dias (10–20 min/dia).",
            "5) Protocolo anti-ansiedade (2–4 técnicas; 1–5 min).",
            "6) 3 métricas para amanhã (simples).",
            "7) Se houver gaps, como corrigir o registro.",
        ],
        "restricoes": ["Sem misticismo.", "Sem promessas absolutas.", "Nada perigoso."],
        "formato": "Markdown com títulos curtos e listas.",
    }

    return system_text, json.dumps(user_payload, ensure_ascii=False), stats


# ============================================================
# Lifecycle
# ============================================================
@app.on_event("startup")
def on_startup() -> None:
    global _conn
    _conn = _connect()
    with _lock:
        _init_schema(_conn)
        _sync(_conn)


@app.on_event("shutdown")
def on_shutdown() -> None:
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        finally:
            _conn = None


# ============================================================
# Endpoints
# ============================================================
@app.get("/health")
def health():
    return {
        "ok": True,
        "db_file": DB_FILE,
        "turso_enabled": bool(TURSO_URL and TURSO_TOKEN),
        "turso_url": TURSO_URL if TURSO_URL else None,
        "snix_enabled": bool(GEMINI_API_KEY),
        "snix_provider": "gemini",
        "gemini_model": GEMINI_MODEL,
        "gemini_base": GEMINI_BASE_URL,
        "snix_cache_ttl_sec": SNIX_CACHE_TTL_SEC,
        "snix_retries": SNIX_RETRIES,
    }


@app.get("/llm/models")
def llm_models():
    return _gemini_list_models()


@app.get("/state")
def get_state():
    conn = _require_conn()

    with _lock:
        row = conn.execute("SELECT goals_json, theme FROM state WHERE id=1;").fetchone()
        if not row:
            raise HTTPException(status_code=500, detail="State não inicializado (id=1 ausente).")

        try:
            goals_raw = json.loads(row[0] or "{}")
        except Exception:
            goals_raw = {}

        goals = _merge_goals(goals_raw)
        theme = row[1] if row[1] in ("dark", "light") else "dark"

        logs_rows = conn.execute("""
            SELECT date, sleep, sleepQual, trained, trainMin, trainType, foodScore, water, meals, mood, anxiety, notes
            FROM logs
            ORDER BY date DESC;
        """).fetchall()

    logs: List[Dict[str, Any]] = [_row_to_log(r) for r in logs_rows]
    return {"logs": logs, "goals": goals, "theme": theme}


@app.post("/logs")
def upsert_log(payload: LogIn):
    conn = _require_conn()

    if len(payload.date) != 10 or payload.date[4] != "-" or payload.date[7] != "-":
        raise HTTPException(status_code=422, detail="date deve estar no formato YYYY-MM-DD.")

    sleep = float(payload.sleep)
    sleep_qual = int(payload.sleepQual)
    food = int(payload.foodScore)
    mood = int(payload.mood)
    anx = int(payload.anxiety)
    train_min = int(payload.trainMin or 0)

    if sleep < 0 or sleep > 24:
        raise HTTPException(status_code=422, detail="sleep deve estar entre 0 e 24.")
    if sleep_qual < 1 or sleep_qual > 5:
        raise HTTPException(status_code=422, detail="sleepQual deve estar entre 1 e 5.")
    if food < 1 or food > 5:
        raise HTTPException(status_code=422, detail="foodScore deve estar entre 1 e 5.")
    if mood < 0 or mood > 10:
        raise HTTPException(status_code=422, detail="mood deve estar entre 0 e 10.")
    if anx < 0 or anx > 10:
        raise HTTPException(status_code=422, detail="anxiety deve estar entre 0 e 10.")
    if train_min < 0 or train_min > 600:
        raise HTTPException(status_code=422, detail="trainMin fora do intervalo esperado (0–600).")

    with _lock:
        conn.execute("""
        INSERT INTO logs (date, sleep, sleepQual, trained, trainMin, trainType, foodScore, water, meals, mood, anxiety, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          sleep=excluded.sleep,
          sleepQual=excluded.sleepQual,
          trained=excluded.trained,
          trainMin=excluded.trainMin,
          trainType=excluded.trainType,
          foodScore=excluded.foodScore,
          water=excluded.water,
          meals=excluded.meals,
          mood=excluded.mood,
          anxiety=excluded.anxiety,
          notes=excluded.notes;
        """, (
            payload.date,
            sleep,
            sleep_qual,
            _bool_to_int(payload.trained),
            train_min,
            (payload.trainType or ""),
            food,
            _bool_to_int(payload.water),
            _bool_to_int(payload.meals),
            mood,
            anx,
            payload.notes or "",
        ))
        conn.commit()
        _sync(conn)

    return {"ok": True}


@app.delete("/logs/{date_str}")
def delete_log(date_str: str):
    conn = _require_conn()

    if len(date_str) != 10 or date_str[4] != "-" or date_str[7] != "-":
        raise HTTPException(status_code=422, detail="date deve estar no formato YYYY-MM-DD.")

    with _lock:
        conn.execute("DELETE FROM logs WHERE date=?;", (date_str,))
        conn.commit()
        _sync(conn)

    return {"ok": True}


@app.put("/settings")
def save_settings(payload: SettingsIn):
    conn = _require_conn()

    merged = _merge_goals(payload.goals or {})
    theme = payload.theme if payload.theme in ("dark", "light") else "dark"

    with _lock:
        conn.execute(
            "UPDATE state SET goals_json=?, theme=? WHERE id=1;",
            (json.dumps(merged), theme),
        )
        conn.commit()
        _sync(conn)

    return {"ok": True, "goals": merged, "theme": theme}


# ============================================================
# Snix Coach
# ============================================================
@app.post("/coach/snix", response_model=SnixCoachOut)
def snix_coach(payload: SnixCoachIn):
    conn = _require_conn()

    days = max(3, min(60, int(payload.days)))
    max_items = max(10, min(240, int(payload.max_items)))
    focus = (payload.focus or "ansiedade").strip()[:40]
    include_notes = bool(payload.include_notes)

    with _lock:
        row = conn.execute("SELECT goals_json, theme FROM state WHERE id=1;").fetchone()
        if not row:
            raise HTTPException(status_code=500, detail="State não inicializado (id=1 ausente).")

        try:
            goals_raw = json.loads(row[0] or "{}")
        except Exception:
            goals_raw = {}
        goals = _merge_goals(goals_raw)

        rows = conn.execute("""
            SELECT date, sleep, sleepQual, trained, trainMin, trainType, foodScore, water, meals, mood, anxiety, notes
            FROM logs
            ORDER BY date DESC
            LIMIT ?;
        """, (max_items,)).fetchall()

    logs_desc = [_row_to_log(r) for r in rows]
    if not logs_desc:
        raise HTTPException(status_code=422, detail="Sem logs suficientes para análise do Snix.")

    sel = _select_window_from_logs(logs_desc=logs_desc, days=days)
    window = sel["window"]
    if len(window) < 3:
        raise HTTPException(status_code=422, detail="Poucos dados na janela (mínimo 3 dias).")

    system_text, user_text, stats = _build_snix_prompt(goals, window, focus, include_notes)

    # chave de cache: mesma janela, mesmo foco, mesmas notas => reutiliza
    cache_key = f"days={days}|focus={focus}|notes={int(include_notes)}|end={sel['used_end_date']}|n={len(window)}"
    cached = _cache_get(cache_key)
    if cached:
        return SnixCoachOut(**cached)

    # tenta LLM; se bater quota, devolve fallback (200 OK)
    try:
        out = _gemini_generate(
            system_text=system_text,
            user_text=user_text,
            model=GEMINI_MODEL,
            temperature=0.35,
            max_output_tokens=SNIX_MAX_OUTPUT_TOKENS,
            top_p=0.95,
        )

        report = (out.get("text") or "").strip()
        meta = out.get("meta") or {}

        if meta.get("block_reason"):
            report = (
                "Sem resposta do Snix: a API bloqueou o conteúdo desta solicitação.\n"
                "Tente foco diferente (ex.: 'sono', 'rotina') ou desative include_notes."
            )
        if not report:
            report = (
                "Sem resposta do Snix (texto vazio).\n"
                "Aumente a janela (ex.: 21 dias) ou reduza notas (include_notes=false)."
            )

        if sel["future_count"] > 0:
            report += (
                "\n\nNota técnica: detectei registros em datas futuras. "
                "A inferência prioriza dados até a data atual; o futuro é melhor como planejamento."
            )

        stats_out = {
            **stats,
            "sleepMin": goals.get("sleepMin"),
            "window_start_selected": sel["used_start_date"],
            "window_end_selected": sel["used_end_date"],
            "used_past_only": sel["used_past_only"],
            "future_count": sel["future_count"],
            "llm_meta": meta,
            "cache_key": cache_key,
        }

        result = SnixCoachOut(
            ok=True,
            coach="Snix",
            model=_validate_gemini_model_name(GEMINI_MODEL),
            days=days,
            n_logs_used=len(window),
            report=report,
            stats=stats_out,
        ).model_dump()

        _cache_set(cache_key, result)
        return SnixCoachOut(**result)

    except HTTPException as e:
        # Se for quota (429) ela vem encapsulada como 502 detail "... 429 ..."
        detail = str(e.detail or "")
        is_quota = (" 429 " in detail) or ("RESOURCE_EXHAUSTED" in detail) or ("exceeded your current quota" in detail)

        if is_quota:
            stats_out = {
                **stats,
                "sleepMin": goals.get("sleepMin"),
                "window_start_selected": sel["used_start_date"],
                "window_end_selected": sel["used_end_date"],
                "used_past_only": sel["used_past_only"],
                "future_count": sel["future_count"],
                "llm_meta": {"error": "quota_exhausted"},
                "cache_key": cache_key,
            }

            report = _snix_fallback_report(stats_out, focus)
            result = SnixCoachOut(
                ok=True,
                coach="Snix",
                model="offline-fallback",
                days=days,
                n_logs_used=len(window),
                report=report,
                stats=stats_out,
            ).model_dump()

            _cache_set(cache_key, result)
            return SnixCoachOut(**result)

        # outros erros: sobe mesmo
        raise

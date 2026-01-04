# LifeOps 🧠📊  
**Dashboard pessoal + API FastAPI + Banco (SQLite/Turso) + Coach IA (Snix/Gemini)**

**Space (API online):**
```text
https://huggingface.co/spaces/ViniciusKhan/LifeOps
````

---

## 1) Propósito (sem floreio)

O **LifeOps** é um sistema de **auto-monitoramento de hábitos** com foco em **sono, treino, alimentação, humor e ansiedade**, oferecendo:

* **Registro diário (logs)** estruturado e consistente.
* **Estado central (goals + theme)** para metas e configuração.
* **Análises objetivas** (médias, picos, tendência, correlações simples).
* **Coach IA “Snix”** (Gemini) para gerar **insights acionáveis** a partir dos dados.
* **Fallback offline determinístico** quando a IA falha (quota, rate-limit, instabilidade).

> Filosofia do projeto: **dados primeiro**. IA entra como camada de valor — não como muleta.

---

## 2) O que este projeto entrega

### 2.1 Funcionalidades principais

* **API REST** (FastAPI):

  * CRUD de logs (upsert e delete)
  * leitura de estado global (logs + metas + tema)
  * update de settings (metas + tema)
  * healthcheck
  * listagem de modelos Gemini disponíveis (se chave configurada)
  * endpoint de coach (`/coach/snix`) com:

    * seleção de janela (ex.: 14 dias)
    * estatísticas do período
    * cache em memória por TTL
    * retry com backoff em 429/5xx
    * fallback offline quando quota estoura

* **Persistência**:

  * **SQLite local** por padrão
  * **Turso (libSQL)** opcional com **embedded replica + sync**

### 2.2 Aviso importante (saúde)

O Snix **não faz diagnóstico** médico/psicológico. Ele produz **orientações de hábitos** e **experimentos simples** baseados em padrões dos seus registros. Se houver sofrimento intenso/persistente, o correto é buscar apoio de um adulto de confiança e/ou profissional.

---

## 3) Arquitetura (alto nível)

```text
Frontend (HTML/JS)  --->  LifeOps API (FastAPI)
                               |
                               +--> SQLite local (DB_FILE)
                               |
                               +--> Turso Sync (opcional) [TURSO_DATABASE_URL + TURSO_AUTH_TOKEN]
                               |
                               +--> Gemini (opcional) [GEMINI_API_KEY]
                                      |
                                      +--> Snix (relatório em Markdown)
                                      +--> fallback offline (se quota/erro)
```

---

## 4) Stack / Tecnologias

* **Python 3.11**
* **FastAPI** (API)
* **Uvicorn** (ASGI server)
* **libSQL / Turso via libsql** (SQLite + sync opcional)
* **Pydantic** (schemas)
* **python-dotenv** (variáveis via `.env`)
* **Gemini API** (coach Snix) via chamadas HTTP (urllib)

---

## 5) Endpoints (API completa)

> Base URL no Hugging Face:
> use o link do Space como referência e o “App URL” exibido pelo próprio Hugging Face.

### 5.1 Healthcheck

#### `GET /health`

Retorna status da API, DB, Turso e Gemini.

* **Resposta (exemplo)**:

```json
{
  "ok": true,
  "db_file": "./data/lifeops.db",
  "turso_enabled": false,
  "snix_enabled": true,
  "snix_provider": "gemini",
  "gemini_model": "gemini-2.5-flash",
  "snix_cache_ttl_sec": 900,
  "snix_retries": 3
}
```

---

### 5.2 Estado completo (logs + metas + tema)

#### `GET /state`

Retorna:

* `logs`: lista de registros diários

* `goals`: metas (sleepMin, workoutsPerWeek, foodTarget, anxietyMax)

* `theme`: `dark` ou `light`

* **Resposta (shape)**:

```json
{
  "logs": [
    {
      "date": "2026-01-04",
      "sleep": 7.5,
      "sleepQual": 4,
      "trained": true,
      "trainMin": 35,
      "trainType": "forca",
      "foodScore": 4,
      "water": true,
      "meals": true,
      "mood": 7,
      "anxiety": 4,
      "notes": "..."
    }
  ],
  "goals": {
    "sleepMin": 7.0,
    "workoutsPerWeek": 3,
    "foodTarget": 4,
    "anxietyMax": 6
  },
  "theme": "dark"
}
```

---

### 5.3 Criar/atualizar log (upsert)

#### `POST /logs`

Insere ou atualiza um registro pelo `date` (chave primária).

* **Body**:

```json
{
  "date": "YYYY-MM-DD",
  "sleep": 7.0,
  "sleepQual": 3,
  "trained": false,
  "trainMin": 0,
  "trainType": "",
  "foodScore": 4,
  "water": true,
  "meals": true,
  "mood": 7,
  "anxiety": 5,
  "notes": "texto opcional"
}
```

* **Validações**:

  * `sleep`: 0–24
  * `sleepQual`: 1–5
  * `foodScore`: 1–5
  * `mood`: 0–10
  * `anxiety`: 0–10
  * `trainMin`: 0–600
  * `date`: `YYYY-MM-DD`

* **Resposta**:

```json
{ "ok": true }
```

---

### 5.4 Remover log por data

#### `DELETE /logs/{date}`

Exemplo: `DELETE /logs/2026-01-04`

* **Resposta**:

```json
{ "ok": true }
```

---

### 5.5 Atualizar metas e tema

#### `PUT /settings`

* **Body**:

```json
{
  "goals": {
    "sleepMin": 7.5,
    "workoutsPerWeek": 4,
    "foodTarget": 4,
    "anxietyMax": 6
  },
  "theme": "dark"
}
```

* **Resposta**:

```json
{
  "ok": true,
  "goals": { "...": "..." },
  "theme": "dark"
}
```

---

### 5.6 Modelos do Gemini (diagnóstico)

#### `GET /llm/models`

Lista modelos disponíveis na sua conta Google (exige `GEMINI_API_KEY` configurada).

* Se a chave não estiver configurada → retorna erro 503.

---

### 5.7 Snix Coach (IA + fallback)

#### `POST /coach/snix`

Gera relatório em **Markdown** baseado numa janela de dias.

* **Body**:

```json
{
  "days": 14,
  "max_items": 60,
  "focus": "ansiedade",
  "include_notes": true
}
```

* **Resposta (shape)**:

```json
{
  "ok": true,
  "coach": "Snix",
  "model": "gemini-2.5-flash",
  "days": 14,
  "n_logs_used": 12,
  "report": "# ... markdown ...",
  "stats": {
    "window_start": "2025-12-20",
    "window_end": "2026-01-02",
    "avg_sleep": 6.9,
    "avg_anxiety": 6.1,
    "high_anxiety_days": 4,
    "peak_anxiety": 9,
    "peak_date": "2025-12-28",
    "trend": { "anxiety_delta": 0.8, "sleep_delta": -0.6, "mood_delta": -0.5 },
    "cache_key": "..."
  }
}
```

* **Fallback offline**:

  * Se ocorrer quota/rate-limit (tipicamente 429), a API responde **200 OK** com `model: "offline-fallback"` e um relatório determinístico, baseado em estatística e plano mínimo (sem IA).
  * Tradução: **você não fica travado por birra de quota**.

---

## 6) Variáveis de ambiente (.env)

Exemplo de `.env` (NÃO commitar):

```bash
# DB
DB_FILE=./data/lifeops.db

# Turso (opcional)
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...

# Gemini (opcional)
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta

# Snix (tuning)
SNIX_CACHE_TTL_SEC=900
SNIX_RETRIES=3
SNIX_BACKOFF_BASE=0.8
SNIX_BACKOFF_CAP=8.0
SNIX_MAX_OUTPUT_TOKENS=800
```

---

## 7) Como rodar localmente

### 7.1 Instalação

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux/Mac
source .venv/bin/activate

pip install -r requirements.txt
```

### 7.2 Executar

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 7.3 Teste rápido

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/state
```

Docs Swagger:

```text
http://127.0.0.1:8000/docs
```

---

## 8) Deploy no Hugging Face Spaces (Docker)

Pré-requisitos:

* Space configurado como **Docker**
* `Dockerfile`, `main.py`, `requirements.txt` no repositório
* Secrets configurados (Settings → Repository secrets)

Secrets recomendados:

* `GEMINI_API_KEY`
* `GEMINI_MODEL`
* `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` (se usar sync)

Observações:

* O Spaces costuma expor a aplicação na porta `7860` (ou variável `$PORT`).
* O Dockerfile usa:

```bash
uvicorn main:app --host 0.0.0.0 --port ${PORT:-7860}
```

---

## 9) Modelo de dados (logs)

Cada registro diário usa:

* `date` (YYYY-MM-DD) **chave primária**
* `sleep` (horas)
* `sleepQual` (1–5)
* `trained` (bool)
* `trainMin` (0–600)
* `trainType` (texto curto)
* `foodScore` (1–5)
* `water` (bool)
* `meals` (bool)
* `mood` (0–10)
* `anxiety` (0–10)
* `notes` (texto livre)

---

## 10) Segurança e boas práticas (sem drama)

* Não exponha `.env`.
* Em produção, **restrinja CORS** (hoje está `*` por praticidade).
* Evite logs com dados sensíveis em `notes`.
* LLM: trate como sistema auxiliar; **não confunda saída com verdade**.

---

## 11) Roadmap (próximos upgrades)

* Autenticação (token simples) para evitar escrita pública
* Rate-limit no Snix
* Métricas por mês/semana e export (CSV)
* Dashboard mais “bi de verdade” (tendências e alertas com thresholds)

---

## 12) Autor

**Vinicius de Souza Santos**
Projeto desenvolvido e mantido por **Vinicius Santos**.

Space público:

```text
https://huggingface.co/spaces/ViniciusKhan/LifeOps
```

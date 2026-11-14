# HORIZON — Backend API

Specyfikacja API dla frontendu HORIZON (ekrany z makiety v2). Wersja robocza na hackathon.

- **Base URL:** `/api/v1`
- **Format:** JSON, UTF-8
- **Auth:** brak (publiczne dane NASA)
- **CORS:** zezwól na origin frontendu (lokalnie `http://localhost:5173`)

---

## 1. Rola backendu

Frontend nie może sam liczyć tego, co ciężkie albo zależne od dużych danych. Backend:

1. **Pobiera efemerydy** Słońca i Ziemi z **JPL Horizons** (azymut/elewacja dla punktu na Księżycu) i je cache'uje — przeglądarka nie odpytuje Horizons bezpośrednio (CORS, limity, czas).
2. **Liczy maskę horyzontu** z **LOLA DEM** (PGDA): dla każdego azymutu kąt elewacji terenu widziany z miejsca lądowania.
3. **Uruchamia symulację** misji: widoczność Słońca/Ziemi, okna pracy, bateria, ocena powodzenia.
4. **Liczy rzeczy masowe**: kalendarz dat (wiele symulacji), mapę wrażliwości (siatka punktów), porównanie scenariuszy.
5. **Udostępnia warstwy mapy** (oświetlenie, widoczność Ziemi, PSR, nachylenie) i metadane źródeł do panelu walidacji.

Zasada: **wszystko, co da się policzyć z wyprzedzeniem dla miejsc z katalogu, liczymy z wyprzedzeniem**. Obliczenia na żywo tylko dla własnych współrzędnych.

---

## 2. Konwencje

| Rzecz | Konwencja |
|---|---|
| Szerokość `lat` | stopnie, −90…90, północ dodatnia |
| Długość `lon` | stopnie, −180…180, wschód dodatni (backend przyjmuje też 0…360 i normalizuje) |
| Azymut `az` | stopnie, 0…360, od północy lokalnej zgodnie z ruchem wskazówek zegara |
| Elewacja `el` | stopnie nad **płaskim horyzontem** (sfera); bez refrakcji — Księżyc nie ma atmosfery |
| Czas | ISO 8601 w UTC, np. `2027-03-14T06:00:00Z` |
| Czas względny | `t` w dniach od lądowania (liczba zmiennoprzecinkowa) |
| Długości | metry (`m`), kilometry (`km`) — jednostka zawsze w nazwie pola, np. `radiusKm` |
| Energia/moc | `Wh`, `W` |
| Procenty | 0–100, liczba |

### Błędy

Każdy błąd ma ten sam kształt:

```json
{
  "error": {
    "code": "OUT_OF_DEM_COVERAGE",
    "message": "No LOLA terrain for this point. Terrain-based results need latitude ≤ -80°.",
    "field": "lat"
  }
}
```

| HTTP | `code` | Kiedy |
|---|---|---|
| 400 | `VALIDATION_ERROR` | zły zakres/format parametru (`field` wskazuje które) |
| 404 | `NOT_FOUND` | nieznane `siteId`, `simulationId` |
| 422 | `OUT_OF_DEM_COVERAGE` | punkt poza zasięgiem DEM — można wtedy użyć `horizonModel: "flat"` |
| 429 | `RATE_LIMITED` | za dużo ciężkich zapytań (kalendarz, nearby) |
| 502 | `UPSTREAM_ERROR` | Horizons nie odpowiada; `retryAfterS` w odpowiedzi |
| 504 | `TIMEOUT` | obliczenie trwało za długo — użyj trybu async (patrz §5) |

---

## 3. Przegląd endpointów

| Priorytet | Metoda | Ścieżka | Ekran(y) |
|---|---|---|---|
| **MVP** | GET | `/sites` | Explore, Catalog |
| **MVP** | GET | `/sites/{id}` | Site |
| **MVP** | GET | `/terrain/point` | Explore (pasek LAT/LON/ELEV), Site |
| **MVP** | POST | `/simulations` | Popup → Simulation Basic/Pro |
| **MVP** | GET | `/simulations/{id}` | Simulation (link do udostępnienia), Mission brief |
| **MVP** | POST | `/calendar` | Compare dates (miesiące + widok roku) |
| Ważne | GET | `/horizon` | Simulation (Sky 360°, pierścień horyzontu w 3D), Pro |
| Ważne | GET | `/terrain/heightmap` | Simulation (teren w scenie 3D) |
| Ważne | GET | `/ephemeris` | Pro (surowe dane, eksport) |
| Ważne | POST | `/scenarios/compare` | Scenarios |
| Ważne | POST | `/nearby` | Better places nearby |
| Ważne | GET | `/meta/sources` | Pro → Data & validation |
| Ważne | GET | `/validation` | Pro → Data & validation |
| Dodatkowe | GET | `/layers/{layer}/tiles/{z}/{x}/{y}.png` | Site (warstwy mapy) |
| Dodatkowe | GET | `/route` | Popup (trasa Ziemia → Księżyc) |
| Dodatkowe | GET | `/simulations/{id}/brief.pdf` | Mission brief |
| Dodatkowe | GET | `/jobs/{id}` | długie obliczenia (async) |
| — | GET | `/health` | monitoring |

---

## 4. Endpointy

### 4.1 `GET /sites` — katalog miejsc

Query (wszystko opcjonalne):

| Parametr | Typ | Przykład |
|---|---|---|
| `group` | `Artemis III` \| `CLPS` \| `Commercial` \| `Other nations` \| `Apollo` | `CLPS` |
| `region` | `South pole` \| `Near side` \| `Far side` | `South pole` |
| `q` | tekst (nazwa, program, agencja) | `chang` |
| `featured` | `true` | lista z ekranu Explore |

Odpowiedź `200`:

```json
{
  "items": [
    {
      "id": "connecting-ridge",
      "name": "Connecting Ridge",
      "program": "Artemis III",
      "group": "Artemis III",
      "status": "candidate (2022 list)",
      "lat": -89.45,
      "lon": -137.3,
      "region": "South pole",
      "coordsVerified": false,
      "precomputed": true
    }
  ],
  "total": 19
}
```

- `coordsVerified` — czy współrzędne sprawdzone w QuickMap (frontend pokazuje ostrzeżenie przy `false`).
- `precomputed` — czy maska horyzontu i efemerydy są policzone z wyprzedzeniem (szybka symulacja).

### 4.2 `GET /sites/{id}` — szczegóły miejsca

```json
{
  "id": "connecting-ridge",
  "name": "Connecting Ridge",
  "description": "Ridge between Shackleton and de Gerlache craters.",
  "lat": -89.45,
  "lon": -137.3,
  "elevationM": 1912,
  "slopeDeg": 4.1,
  "region": "South pole",
  "demCoverage": true,
  "precomputed": true,
  "sources": ["LOLA 5 m/px (PGDA)", "JPL Horizons"]
}
```

### 4.3 `GET /terrain/point` — wysokość i nachylenie pod kursorem / pinezką

Query: `lat`, `lon` (wymagane).

```json
{
  "lat": -89.45,
  "lon": -137.3,
  "elevationM": 1912,
  "slopeDeg": 4.1,
  "demCoverage": true,
  "demResolutionM": 5,
  "inPermanentShadow": false,
  "nearestSite": { "id": "connecting-ridge", "distanceKm": 0.0 }
}
```

Ma być **szybki (< 100 ms)** — wołany przy każdym kliknięciu w globus. Poza zasięgiem DEM: `demCoverage: false`, `elevationM` z globalnego modelu LOLA o niższej rozdzielczości albo `null`.

### 4.4 `GET /horizon` — maska horyzontu

Query:

| Parametr | Typ | Domyślnie | Opis |
|---|---|---|---|
| `lat`, `lon` | number | — | punkt |
| `heightM` | number | `2` | wysokość obserwatora nad gruntem (panel/maszt) |
| `binDeg` | number | `0.5` | rozdzielczość azymutu (0.1 w Pro) |

```json
{
  "lat": -89.45,
  "lon": -137.3,
  "heightM": 2,
  "binDeg": 0.5,
  "maxDistanceKm": 150,
  "azimuthDeg": [0, 0.5, 1.0, "…", 359.5],
  "elevationDeg": [0.35, 0.36, 0.38, "…", 0.34],
  "features": [
    { "name": "Malapert massif", "azFromDeg": 107, "azToDeg": 150, "maxElevationDeg": 1.95 }
  ],
  "demVersion": "LOLA-PGDA-87S-5m-v1"
}
```

Używane przez widok **Sky 360°**. `features` są opcjonalne (etykiety gór na panoramie).

### 4.5 `GET /ephemeris` — surowe pozycje Słońca i Ziemi

Query: `lat`, `lon`, `start`, `end` (ISO), `stepMin` (domyślnie `10`), `bodies` (`sun,earth`).

```json
{
  "start": "2027-03-14T06:00:00Z",
  "stepMin": 10,
  "sun":   { "azDeg": [241.0, 241.1, "…"], "elDeg": [1.17, 1.17, "…"], "distanceKm": [149600000, "…"] },
  "earth": { "azDeg": [9.6, 9.6, "…"],     "elDeg": [3.10, 3.09, "…"] },
  "source": "JPL Horizons API, observer on body 301, airless, DE441"
}
```

Tablice zamiast listy obiektów — 4320 próbek na 30 dni, oszczędza transfer. Pro używa tego do wykresów i eksportu CSV.

### 4.6 `POST /simulations` — symulacja misji ⭐ najważniejszy

Request:

```json
{
  "site": { "siteId": "connecting-ridge" },
  "landingTime": "2027-03-14T06:00:00Z",
  "missionDays": 14,
  "windowDays": 30,
  "stepMin": 10,
  "horizonModel": "real",
  "hardware": {
    "batteryWh": 20000,
    "solarW": 600,
    "dayLoadW": 300,
    "nightLoadW": 140,
    "reservePct": 20,
    "panelHeightM": 2.0,
    "mastHeightM": 3.5
  },
  "weights": { "power": 0.5, "comms": 0.3, "night": 0.2 },
  "includeTimeseries": true
}
```

- `site` to **albo** `{ "siteId": "…" }`, **albo** `{ "lat": -89.45, "lon": -137.3 }`.
- `horizonModel`: `"real"` (teren LOLA) albo `"flat"` (gładka sfera) — przełącznik „Real terrain ↔ Flat horizon”.
- `hardware` i `weights` opcjonalne — domyślne wartości jak wyżej (preset „CLPS-class lander”).

Odpowiedź `201`:

```json
{
  "id": "sim_7f3k2",
  "createdAt": "2026-11-14T10:30:00Z",
  "input": { "…": "echo requestu z uzupełnionymi domyślnymi" },
  "site": { "name": "Connecting Ridge", "lat": -89.45, "lon": -137.3, "elevationM": 1912 },
  "summary": {
    "successPct": 50,
    "verdict": "RISKY",
    "flatHorizonSuccessPct": 97,
    "sunlitPct": 64,
    "earthVisiblePct": 56,
    "bothPct": 56,
    "minSocPct": 16,
    "minSocAtDay": 14.0,
    "longestNightH": 120,
    "longestCommsGapH": 264,
    "firstSunsetDay": 9.0,
    "firstEarthsetDay": 7.9
  },
  "factors": [
    { "key": "power", "metric": "minSocPct", "value": 16, "score": 0.20, "weight": 0.5, "points": 10, "ok": false },
    { "key": "comms", "metric": "earthVisiblePct", "value": 56, "score": 1.00, "weight": 0.3, "points": 30, "ok": true },
    { "key": "night", "metric": "longestNightH", "value": 120, "score": 0.50, "weight": 0.2, "points": 10, "ok": false }
  ],
  "events": [
    { "type": "EARTHSET",      "time": "2027-03-22T03:36:00Z", "day": 7.9,  "azDeg": 348.2, "elDeg": 1.92 },
    { "type": "SUNSET",        "time": "2027-03-23T06:00:00Z", "day": 9.0,  "azDeg": 286.4, "elDeg": 0.71 },
    { "type": "BATTERY_LOW",   "time": "2027-03-28T00:14:00Z", "day": 13.8 },
    { "type": "MISSION_END",   "time": "2027-03-28T06:00:00Z", "day": 14.0 },
    { "type": "SUNRISE",       "time": "2027-03-28T22:05:00Z", "day": 14.7, "azDeg": 241.0, "elDeg": 0.42 },
    { "type": "EARTHRISE",     "time": "2027-03-30T10:48:00Z", "day": 16.2, "azDeg": 9.6,   "elDeg": 0.94 }
  ],
  "windows": {
    "sun":   [{ "fromDay": 0, "toDay": 9.0 }, { "fromDay": 14.7, "toDay": 28.3 }],
    "earth": [{ "fromDay": 0, "toDay": 7.9 }, { "fromDay": 16.2, "toDay": 30 }],
    "both":  [{ "fromDay": 0, "toDay": 7.9 }, { "fromDay": 16.2, "toDay": 28.3 }]
  },
  "timeseries": {
    "stepMin": 10,
    "day":           [0, 0.0069, "…"],
    "sunAzDeg":      [241.0, "…"],
    "sunElDeg":      [1.17, "…"],
    "sunMaskElDeg":  [0.35, "…"],
    "sunVisibleFrac":[1.0, "…"],
    "earthAzDeg":    [9.6, "…"],
    "earthElDeg":    [3.10, "…"],
    "earthMaskElDeg":[0.80, "…"],
    "earthVisible":  [true, "…"],
    "socPct":        [100, "…"]
  }
}
```

Co z tego bierze frontend:

| Ekran | Pola |
|---|---|
| Simulation Basic — karty | `timeseries` w chwili `t` (elewacja, zapas nad terenem = `el − maskEl`), odliczania z `events` |
| Simulation Basic — pasy osi czasu | `windows` |
| Simulation Basic — bateria | `timeseries.socPct` |
| Simulation Basic — ocena | `summary.successPct`, `factors`, `flatHorizonSuccessPct` |
| Scena 3D | `timeseries.sun*/earth*` (kierunek światła i pozycja Ziemi) |
| Pro | wszystko + eksport |

Czas odpowiedzi: **< 1 s** dla miejsc z katalogu, **< 5 s** dla własnych współrzędnych (liczenie maski). Powyżej → tryb async (§5).

### 4.7 `GET /simulations/{id}` — zapisana symulacja

Ta sama odpowiedź co `POST /simulations`. Służy do linku do udostępnienia i do Mission brief. Symulacje są **niezmienne** — inne parametry = nowe `id`.

### 4.8 `POST /calendar` — ocena dla każdego dnia lądowania

Request:

```json
{
  "site": { "siteId": "connecting-ridge" },
  "from": "2027-01-01",
  "to": "2027-12-31",
  "landingTimeOfDay": "06:00:00Z",
  "missionDays": 14,
  "horizonModel": "real",
  "hardware": { "…": "jak w /simulations" }
}
```

Odpowiedź `200`:

```json
{
  "days": [
    { "date": "2027-03-14", "successPct": 50, "minSocPct": 16, "earthVisiblePct": 56, "longestNightH": 120 },
    { "date": "2027-03-28", "successPct": 92, "minSocPct": 64, "earthVisiblePct": 77, "longestNightH": 31 }
  ],
  "best": { "date": "2027-03-28", "successPct": 92 },
  "months": [
    { "month": "2027-03", "goodDays": 9, "bestPct": 92, "season": "neutral" }
  ]
}
```

- Ekran miesięcy pyta o 2 miesiące, widok roku o 12 — ten sam endpoint.
- `season`: `summer` \| `winter` \| `neutral` — do etykiet w widoku roku.
- Ciężkie (365 symulacji). Dla miejsc z katalogu **policz z wyprzedzeniem** dla domyślnego sprzętu; dla innych parametrów — cache + async.

### 4.9 `POST /scenarios/compare` — porównanie obok siebie

Request: lista 2–4 specyfikacji w formacie `/simulations` (bez `includeTimeseries`).

```json
{
  "scenarios": [
    { "label": "Baseline",       "site": { "siteId": "connecting-ridge" }, "landingTime": "2027-03-14T06:00:00Z", "missionDays": 14 },
    { "label": "Slip +2 weeks",  "site": { "siteId": "connecting-ridge" }, "landingTime": "2027-03-28T06:00:00Z", "missionDays": 14 },
    { "label": "Move 2.1 km",    "site": { "lat": -89.421, "lon": -136.09 }, "landingTime": "2027-03-14T06:00:00Z", "missionDays": 14 }
  ],
  "requirements": { "minSocPct": 20, "minEarthVisiblePct": 50 }
}
```

Odpowiedź: `summary` + `windows` + `simulationId` dla każdego scenariusza oraz rekomendacja:

```json
{
  "results": [ { "label": "Baseline", "simulationId": "sim_7f3k2", "summary": { "…": "…" }, "windows": { "…": "…" }, "meetsRequirements": false } ],
  "recommendation": {
    "label": "Move 2.1 km",
    "reason": "Scores 91 % on the original date — no launch slip needed."
  }
}
```

Reguła rekomendacji (prosta, wyjaśnialna): najwyższy `successPct` wśród spełniających wymagania; przy różnicy < 3 pkt wygrywa ten **bez zmiany daty**.

### 4.10 `POST /nearby` — mapa wrażliwości

Request:

```json
{
  "center": { "lat": -89.45, "lon": -137.3 },
  "radiusKm": 2.5,
  "cellM": 100,
  "landingTime": "2027-03-14T06:00:00Z",
  "missionDays": 14,
  "goal": "balanced",
  "maxSlopeDeg": 10,
  "top": 3
}
```

- `goal`: `balanced` (wagi domyślne) \| `power` \| `comms`.

Odpowiedź:

```json
{
  "grid": {
    "originLat": -89.47, "originLon": -137.9, "cellM": 100, "cols": 50, "rows": 50,
    "successPct": [[48, 51, "…"], "…"],
    "excluded":   [[false, true, "…"], "…"]
  },
  "center": { "successPct": 50 },
  "suggestions": [
    { "rank": "A", "lat": -89.421, "lon": -136.09, "distanceKm": 2.1, "successPct": 91,
      "why": ["+3.4 days of sunlight", "battery never below 48 %", "Earth link unchanged"] }
  ]
}
```

- `excluded` — komórki z nachyleniem > `maxSlopeDeg` lub w PSR (no-go).
- 2 500 komórek × symulacja → **zawsze async** (§5). Optymalizacja: maski horyzontu sąsiednich komórek są prawie takie same → licz rzadziej i interpoluj.

### 4.11 `GET /layers/{layer}/tiles/{z}/{x}/{y}.png` — warstwy mapy

`layer`: `illumination` \| `earth-visibility` \| `psr` \| `slope`.

Kafelki w projekcji biegunowej (jak Moon Trek WMTS). Najprościej: **wygenerować raz** z map PGDA / LOLA i serwować statycznie (CDN), backend tylko podaje URL-e:

`GET /layers` →

```json
{
  "layers": [
    { "id": "illumination", "name": "Sunlight (avg.)", "source": "NASA GSFC PGDA", "tileUrl": "/tiles/illumination/{z}/{x}/{y}.png", "legend": [{ "value": 80, "label": "80 %+" }] }
  ]
}
```

### 4.12 `GET /route` — trasa Ziemia → Księżyc (popup)

Query: `landingTime`, `transfer` (`direct` \| `low-energy`).

```json
{
  "transfer": "direct",
  "launch": { "time": "2027-03-10T01:00:00Z", "site": "KSC LC-39B" },
  "legs": [
    { "name": "Launch + TLI", "durationH": 2 },
    { "name": "Coast to Moon", "durationH": 74 },
    { "name": "Lunar orbit", "durationH": 24 },
    { "name": "Descent", "durationH": 1 }
  ],
  "totalDurationH": 101,
  "earthMoonDistanceKm": 384400,
  "note": "Planning estimates, not a trajectory solution."
}
```

Czasy etapów to **szacunki planistyczne** (stałe w konfiguracji), nie obliczona trajektoria — tak to też opisujemy w UI.

### 4.13 `GET /meta/sources` i `GET /validation` — panel Data & validation

`GET /meta/sources`:

```json
{
  "ephemeris": { "name": "JPL Horizons API", "version": "1.3", "model": "DE441", "retrievedAt": "2026-11-12" },
  "terrain":   { "name": "LOLA DEM (NASA GSFC PGDA)", "nearFieldM": 5, "farFieldM": 20, "maxDistanceKm": 150 },
  "basemap":   { "name": "Moon Trek WMTS" },
  "validationRefs": ["PGDA illumination map", "LROC WAC south pole illumination (88–90°S, 100 m/px)"]
}
```

`GET /validation?lat=&lon=`:

```json
{
  "avgIlluminationPct": { "horizon": 72.4, "pgda": 70.1, "lrocWac": 74.0 },
  "earthVisibilityPct": { "horizon": 58.0, "pgda": 56.5 },
  "deltaMaxPts": 2.3,
  "withinTolerance": true,
  "tolerancePts": 5
}
```

Średnie liczone po **pełnym cyklu** (rok lub dłużej), żeby były porównywalne z mapami PGDA/LROC. Ten endpoint to argument na nagrodę *Best Use of Science* — jedna liczba „różnica ≤ X pkt” na slajdzie.

### 4.14 Async: `GET /jobs/{id}`

Ciężkie zapytania (`/calendar` z niestandardowym sprzętem, `/nearby`, własne punkty bez cache) mogą odpowiedzieć `202`:

```json
{ "jobId": "job_91ab", "status": "queued", "pollUrl": "/api/v1/jobs/job_91ab" }
```

`GET /jobs/{id}` →

```json
{ "jobId": "job_91ab", "status": "running", "progressPct": 42 }
```

Po zakończeniu: `"status": "done", "result": { …taki sam jak odpowiedź synchroniczna… }` albo `"status": "failed", "error": { … }`. Frontend odpytuje co 1 s i pokazuje pasek postępu.

### 4.16 `GET /terrain/heightmap` — bliski teren do sceny 3D

Query: `lat`, `lon`, `sizeKm` (domyślnie `20`), `res` (siatka, domyślnie `256`), `format` (`json` \| `png16`).

```json
{
  "lat": -89.45, "lon": -137.3,
  "sizeKm": 20, "res": 256,
  "originElevationM": 1912,
  "minElevationM": -2100, "maxElevationM": 2400,
  "heightsM": [[1880.2, 1881.0, "…"], "…"],
  "northUp": true,
  "demVersion": "LOLA-PGDA-87S-5m-v1"
}
```

- Siatka w układzie lokalnym lądownika (środek = punkt lądowania, góra siatki = północ lokalna), wysokości względem punktu lądowania.
- `png16`: jedna 16-bitowa mapa wysokości (mniejszy transfer). Skala w nagłówkach `X-Min-Elevation-M` / `X-Max-Elevation-M`.
- Daleki teren (do 150 km) **nie** idzie tym endpointem — w scenie rysuje go pierścień z `GET /horizon` (§5.6).

### 4.15 `GET /simulations/{id}/brief.pdf` (opcjonalnie)

PDF Mission brief. Na hackathon wystarczy wersja **po stronie frontendu** (`window.print()` z CSS do druku) — ten endpoint dopiero, gdy zostanie czas.

---

## 5. Obliczenia — co dokładnie ma robić backend

### 5.1 Maska horyzontu (LOLA)

1. Wczytaj DEM: 5 m/px w pobliżu (87–90°S), 20 m/px dalej (80–90°S).
2. Dla każdego azymutu (co `binDeg`) rzucaj promień od punktu do **150 km** (przy biegunie cienie rzucają góry odległe o 100+ km).
3. Dla każdej próbki w odległości `d`: `angle = atan((h_teren − h_obserwatora − d²/(2R)) / d)`, gdzie `R = 1737.4 km` (krzywizna Księżyca). Maska = maksimum po próbkach.
4. Wysokość obserwatora = teren + `heightM` (panel lub maszt).
5. `horizonModel: "flat"` → maska = 0° wszędzie.

### 5.2 Efemerydy (Horizons)

- Obserwator na powierzchni ciała 301 (`CENTER='coord@301'`, `COORD_TYPE='GEODETIC'`, `SITE_COORD='lon,lat,alt_km'`), cel: Słońce `10`, Ziemia `399`.
- `QUANTITIES='4'` (azymut/elewacja, bez refrakcji), krok 10 min.
- Cache po kluczu `(lat, lon zaokrąglone do 0.001°, body, zakres, krok)`. Dla katalogu: policz z wyprzedzeniem na 2027–2028.
- Limit równoległych zapytań do Horizons (np. 2) + ponawianie z backoffem.

### 5.3 Widoczność

- **Słońce:** tarcza ~0.53°. `sunVisibleFrac` = część tarczy nad maską (0…1); „sunlit”, gdy `> 0`.
- **Ziemia:** tarcza ~1.9°. Widoczna, gdy **jakakolwiek** część tarczy jest nad maską (tak jak w mapach PGDA).
- Margines łączności (Pro): opcjonalny próg `minEarthClearanceDeg`.

### 5.4 Bateria (zgodnie z prototypem)

Dla każdego kroku `Δt`:

```
P_net = sunlit ? solarW · sunVisibleFrac − dayLoadW : −nightLoadW
E     = clamp(E + P_net · Δt_h, 0, batteryWh)
socPct = E / batteryWh · 100
```

Start: `E = batteryWh`.

### 5.5 Ocena powodzenia (heurystyka — tak ją nazywamy w UI)

W oknie misji `[0, missionDays]`:

```
power = clamp((minSocPct − 10) / 30, 0, 1)
comms = clamp(earthVisiblePct / 50, 0, 1)
night = clamp(1 − (longestNightH − 72) / 96, 0, 1)

successPct = round( clamp( 100 · (wP·power + wC·comms + wN·night), 5, 97 ) )
verdict    = successPct ≥ 80 ? "LIKELY" : successPct ≥ 60 ? "POSSIBLE" : "RISKY"
```

Domyślne wagi: `wP = 0.5`, `wC = 0.3`, `wN = 0.2`. **Front i backend muszą liczyć identycznie** — wspólne „złote” przypadki testowe w `tests/golden/*.json` (wejście → oczekiwany `summary`), uruchamiane w obu projektach.

### 5.6 Kontrakt rysowania (backend ↔ frontend)

- **Backend jest źródłem prawdy o widoczności.** Frontend nie liczy sam, czy Słońce/Ziemia są zasłonięte — bierze `sunVisibleFrac`, `earthVisible`, `events`, `windows` z odpowiedzi. Scena 3D tylko to pokazuje.
- **Próbki co `stepMin`** (domyślnie 10 min). Frontend interpoluje liniowo między próbkami; azymut po najkrótszym łuku (359° → 0°).
- **Az/el → wektor** w układzie lądownika (Y w górę, −Z północ, X wschód):
  `x = cos(el)·sin(az)`, `y = sin(el)`, `z = −cos(el)·cos(az)`. Ten wektor = kierunek światła słonecznego i pozycja Ziemi na sferze nieba.
- **Scena = bliski teren + pierścień horyzontu.** Bliski teren z `/terrain/heightmap`. Daleki teren jako cylinder o promieniu `R_ring` z wysokością ściany `tan(maskEl(az)) · R_ring` z `/horizon` — dzięki temu Słońce chowa się w scenie dokładnie wtedy, gdy backend mówi „blocked”.
- **Przesadzona skala pionowa** (np. ×10, bo na biegunie wszystko dzieje się w 1–2°). Jeśli teren jest podbity `k` razy, kąty ciał i maski podbijamy tak samo:
  `el' = atan(k · tan(el))`. Relacja nad/pod terenem zostaje zachowana. W UI zawsze podpis „Vertical scale ×k”.
- **Spójność `heightM`**: maska (`/horizon`) i symulacja muszą być liczone dla tej samej wysokości obserwatora (panel dla Słońca, maszt dla Ziemi) — backend zwraca obie maski w symulacji (`sunMaskElDeg`, `earthMaskElDeg`).
- **Rozmiar odpowiedzi**: 30 dni × 10 min = 4320 próbek × ~10 pól ≈ 0.4 MB JSON (≈ 0.1 MB po gzip) — OK. Dłuższe okna: zwiększ `stepMin`.

---

## 6. Cache i wydajność

| Co | Gdzie | Klucz |
|---|---|---|
| Efemerydy | dysk / SQLite | `body, lat, lon, start, end, step` |
| Maski horyzontu | pliki `.npy` / JSON | `lat, lon, heightM, binDeg, demVersion` |
| Heightmapy | pliki PNG16 | `lat, lon, sizeKm, res, demVersion` |
| Symulacje | baza (niezmienne) | hash znormalizowanego requestu → to samo `id` |
| Kalendarz katalogu | JSON z wyprzedzeniem | `siteId, rok, preset` |

- Odpowiedzi GET z `ETag` + `Cache-Control: public, max-age=86400` (dane się nie zmieniają).
- Duże tablice w JSON są OK do ~5 MB; przy większych rozważ `gzip` (włączony na serwerze) albo zmniejszenie kroku.

---

## 7. Proponowany stack

- **Python 3.12 + FastAPI** — najlepszy ekosystem do rastrów i astronomii.
- `httpx` (Horizons), `numpy`, `rasterio` (DEM GeoTIFF), `pyproj` (projekcja biegunowa).
- Kolejka async: na hackathon wystarczy `BackgroundTasks` FastAPI + słownik w pamięci; później Redis/RQ.
- Hosting: Render / Fly.io; statyczne kafelki i JSON-y z wyprzedzeniem na CDN.
- Dokumentacja interaktywna za darmo z FastAPI: `/docs` (Swagger) — frontend widzi kontrakt od pierwszego dnia.

### Kolejność prac

1. `GET /sites`, `GET /terrain/point` (na stałych danych) — odblokowuje ekrany 1–3.
2. Skrypt: Horizons + maska dla **jednego** miejsca → `POST /simulations` na danych z dysku.
3. Mock serwer z przykładowymi odpowiedziami z tego README, żeby frontend nie czekał.
4. `/calendar`, `/horizon`, `/scenarios/compare`.
5. `/nearby`, `/validation`, warstwy, `/route`.

---

## 8. Mapowanie ekran → endpointy

| Ekran frontendu | Wywołania |
|---|---|
| 1 · Explore | `GET /sites?featured=true`, `GET /terrain/point` przy kliknięciu w globus |
| 2 · Catalog | `GET /sites?group=&q=` |
| 3 · Site | `GET /sites/{id}` lub `GET /terrain/point`, `GET /layers` |
| 4 · Popup | `GET /route` → po „Run simulation” `POST /simulations` |
| 5 · Nearby | `POST /nearby` (async) |
| 6 · Simulation Basic | wynik `POST /simulations`; przełącznik terenu = drugi `POST` z `horizonModel: "flat"` (lub `summary.flatHorizonSuccessPct`); Sky 360° i pierścień horyzontu = `GET /horizon`; teren 3D = `GET /terrain/heightmap` |
| 7 · Simulation Pro | jak wyżej + `GET /ephemeris`, `GET /meta/sources`, `GET /validation` |
| 8 · Compare dates | `POST /calendar` |
| 9 · Scenarios | `POST /scenarios/compare` |
| 10 · Mission brief | `GET /simulations/{id}` (+ opcjonalnie `brief.pdf`) |

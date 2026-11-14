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
| 422 | `OUT_OF_PGDA_COVERAGE` | walidacja punktu poza zasięgiem polarnych produktów PGDA (65–90°N/S) |
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
| **MVP** | GET | `/terrain/heightmap` | Site, Simulation (teren w scenie 3D) |
| Ważne | GET | `/ephemeris` | Pro (surowe dane, eksport) |
| **MVP** | POST | `/scenarios/compare` | Scenarios |
| Ważne | POST | `/nearby` | Better places nearby |
| Ważne | GET | `/meta/sources` | Pro → Data & validation |
| Ważne | GET | `/validation` | Pro → Data & validation |
| **MVP** | GET | `/layers` | Site (katalog warstw mapy) |
| **MVP** | GET | `/layers/{id}/grid` | Site (siatka nachylenia / PSR) |
| Dodatkowe (planowane) | GET | `/layers/{layer}/tiles/{z}/{x}/{y}.png` | Site (kafelki warstw mapy) |
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
      "coordsVerified": true,
      "precomputed": false
    }
  ],
  "total": 19
}
```

- `coordsVerified` — czy współrzędne sprawdzone w QuickMap (frontend pokazuje ostrzeżenie przy `false`). Potwierdzone są `connecting-ridge`, `shackleton-rim`, `mons-mouton` i `chandrayaan-3`.
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
  "complete": true,
  "nearestSite": { "id": "connecting-ridge", "distanceKm": 0.0 }
}
```

- `complete: false` — wysokość jest, ale nachylenia lub PSR nie udało się pobrać (wolny Moon Trek / PGDA). Wtedy `slopeDeg` i/lub `inPermanentShadow` = `null`, a odpowiedź jest cache'owana tylko 60 s, żeby ponowienie mogło je uzupełnić. Błąd zwracamy tylko, gdy nie ma nawet wysokości w punkcie.

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
  "features": [],
  "demVersion": "LRO_LOLA_DEM_SPole45_100mp_v04",
  "demResolutionM": 100
}
```

Używane przez widok **Sky 360°**. `features` są opcjonalne (etykiety gór na panoramie).
Obecna implementacja zwraca `features: []` i liczy profil z DEM NASA Moon Trek
o nominalnej rozdzielczości 100 m/px, nie z planowanego DEM PGDA 5/20 m/px.
Pierwsze żądanie pobiera obraz obejmujący promień 150 km i jest cache'owane
na dysku jako GeoTIFF; gotowy profil jest cache'owany w SQLite przez 24 godziny.
Pobrania Moon Trek współdzielą limit dwóch równoczesnych żądań i ponawiają
`RemoteProtocolError`/`ReadTimeout` maksymalnie dwa razy.

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
- `missionDays` nie może przekraczać `windowDays`; oba okna muszą mieścić się w 1–30 dniach.
- `stepMin` musi dzielić dokładnie oba okna; limit to 4320 próbek. `landingTime` wymaga strefy czasowej i pełnej minuty.
- Wagi są normalizowane do sumy 1. `includeTimeseries: false` pomija duże tablice przebiegów.
- `horizonModel: "real"` dobiera DEM do szerokości: południowy polarny dla
  `lat <= -45`, północny polarny dla `lat >= 45`, a globalny pomiędzy nimi.
  `"flat"` pozostaje opcją bez maski terenu.

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

Endpoint działa synchronicznie. Przy pierwszym żądaniu z `"real"` pobranie DEM
horyzontu może zająć kilkadziesiąt sekund; efemerydy i profile horyzontu są
cache'owane w SQLite przez źródłowe endpointy.

### 4.7 `GET /simulations/{id}` — zapisana symulacja

Ta sama odpowiedź co `POST /simulations`. Służy do linku do udostępnienia i do
Mission brief. Symulacje są **niezmienne** — inne parametry = nowe `id`.
Wyniki są przechowywane w pamięci procesu (maksymalnie 256) oraz w SQLite
(maksymalnie 256, TTL 24 h), więc restart serwera nie usuwa ich od razu.

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
    { "month": "2027-03", "goodDays": 9, "bestPct": 92 }
  ]
}
```

- Ekran miesięcy pyta o 2 miesiące, widok roku o 12 — ten sam endpoint.
- `from` i `to` są datami UTC włącznie; maksymalny zakres to 366 dni.
  `missionDays` ma zakres 1–30 (domyślnie 14), a `landingTimeOfDay` jest
  godziną UTC (domyślnie `06:00:00Z`).
- Dla każdego dnia używany jest ten sam silnik oceny co `/simulations`, ale
  efemerydy są próbkowane co 60 minut. Zakresy roczne pobierane są z Horizons
  porcjami do 4320 próbek; źródłowy cache ogranicza powtórne pobrania.
- `goodDays` oznacza liczbę dni z `successPct >= 80`. `best` wybiera najwyższy
  wynik, a przy remisie wcześniejszą datę.
- Miesięczne agregaty zawierają `month`, `goodDays` i `bestPct`; nie zwracają
  etykiety pory roku, której nie da się rzetelnie wywnioskować z ziemskiego
  miesiąca kalendarzowego.
- Endpoint działa synchronicznie. Pierwsze roczne żądanie z `real` może być
  długie, ponieważ pobiera horyzont i kilka porcji efemeryd.

### 4.9 `POST /scenarios/compare` — porównanie obok siebie

Request: lista 2–4 specyfikacji w formacie `/simulations` (bez `includeTimeseries`).
Każda specyfikacja zawiera dodatkowo `label`. Domyślne wymagania to
`minSocPct: 20` i `minEarthVisiblePct: 50`; oba progi można nadpisać.

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
Datą bazową jest data pierwszego scenariusza. Jeśli żaden scenariusz nie
spełnia progów, `recommendation` ma wartość `null`. Wyniki `simulationId`
zostają dostępne przez `GET /simulations/{id}`; symulacje nie zawierają
szeregów czasowych.

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
    "originLat": -89.47, "originLon": -137.9, "cellM": 2500, "cols": 3, "rows": 3,
    "successPct": [[null, 62, null], [null, 50, 67], [null, 55, null]],
    "excluded":   [[true, false, true], [true, false, false], [true, false, true]]
  },
  "center": { "successPct": 50 },
  "suggestions": [
    { "rank": "A", "lat": -89.421, "lon": -136.09, "distanceKm": 2.5, "successPct": 67,
      "why": ["+3.4 days of sunlight", "+5.0 pp minimum battery charge"] }
  ]
}
```

- `excluded` — komórki poza `radiusKm`, z nachyleniem > `maxSlopeDeg`, w PSR lub bez danych terenu/PSR.
- Endpoint działa synchronicznie i ogranicza obliczenie do siatki 3×3: środek i maksymalnie cztery punkty kardynalne są symulowane z krokiem 60 minut. Narożniki leżą poza kołowym promieniem i są wykluczone.
- `cellM` jest przyjmowane jako żądana rozdzielczość, ale siatka jest celowo próbkowana rzadziej, aby uniknąć długiego obliczania setek symulacji. `grid.cellM` zwraca rzeczywisty odstęp próbek równy `radiusKm × 1000`.
- `goal` zmienia wagi oceny (`balanced`: 0.5/0.3/0.2, `power`: 0.7/0.15/0.15, `comms`: 0.2/0.6/0.2). Sugestie uwzględniają wyłącznie punkty bez wykluczeń z wynikiem wyższym niż środek.
- DEM dla środka i kandydatów jest pobierany jako jeden wspólny wycinek
  obejmujący horyzont 150 km oraz promień sąsiedztwa. Horyzonty, heightmapa
  i wysokość/nachylenie punktów są liczone z tego samego GeoTIFF-u, jeśli
  pokrywa on żądany obszar; gotowe profile są zapisane przed symulacjami.
  Gdy okolica przecina granicę usług DEM przy 45°N/S, potrzebny jest osobny
  wycinek dla każdej z usług.

### 4.11 `GET /layers` — katalog warstw mapy

`layer`: `illumination` \| `earth-visibility` \| `psr` \| `slope`.

Katalog zwraca cztery warstwy obsługiwane przez frontend. `tileUrl` pozostaje `null`, ponieważ backend nie serwuje jeszcze kafelków; nie zwracamy w nim niedziałających URL-i.

`GET /layers` →

```json
{
  "layers": [
    { "id": "illumination", "name": "Sunlight (avg.)", "source": "PGDA", "tileUrl": null },
    { "id": "earth-visibility", "name": "Earth visibility", "source": "PGDA", "tileUrl": null },
    { "id": "psr", "name": "Permanent shadow", "source": "PGDA", "tileUrl": null },
    { "id": "slope", "name": "Slope > 10°", "source": "LOLA", "tileUrl": null }
  ]
}
```

### 4.11.1 `GET /layers/{id}/grid` — wartości warstwy na siatce

Query takie same jak w `/terrain/heightmap`: `lat`, `lon`, `sizeKm` (`5`,
`10`, `20` lub `40`), `res` (`16`–`512`, domyślnie `256`). Przy tych samych
parametrach `values[row][col]` odpowiadają piksel w piksel `heightsM[row][col]`:
wiersz 0 to północ, kolumna 0 to zachód. `null` oznacza brak danych;
`min` i `max` są liczone tylko z wartości nie-null.

```json
{
  "layerId": "slope",
  "lat": -89.45,
  "lon": -137.3,
  "sizeKm": 20,
  "res": 256,
  "kind": "continuous",
  "unit": "deg",
  "min": 0.0,
  "max": 34.2,
  "values": [[3.1, 2.8, null, "..."], "..."],
  "northUp": true,
  "source": "LOLA DEM 100 m/px",
  "version": "LRO_LOLA_DEM_SPole45_100mp_v04"
}
```

`slope` jest liczony metodą Horna z 3×3 próbek z tej samej heightmapy; brzeg
siatki i okna zawierające NoData zwracają `null`. Slope korzysta z cache'u
heightmapy. `psr` zwraca maskę `1` (w PSR), `0` (poza PSR) lub `null` (poza
pokryciem / NoData), `unit: null`, źródło NASA GSFC PGDA i wersję rastra
`LPSR_80S_20MPP_ADJ`; wynik siatki PSR jest cache'owany przez 24 h.
`illumination` i `earth-visibility` zwracają ciągłe wartości procentowe
(`unit: "%"`) z GeoTIFF-ów NASA GSFC PGDA `AVGVISIB`, uśrednionych w cyklu
nutacyjnym 18,6 roku. Pierwsza warstwa to średni udział widocznej tarczy Słońca,
druga — średnia widoczność Ziemi (PGDA uznaje ją, gdy widoczna jest dowolna
część jej tarczy). Dla 75–90° używane są rastry 120 m/px, a przy krawędzi
pokrycia 65–90° rastry 240 m/px; półkula i produkt są dobierane do lokalizacji
oraz rozmiaru siatki. Wartości są przeliczane z czynnikiem skali GeoTIFF
`4e-5` na procenty. Poza pokryciem polarnym lub w NoData zwracane jest `null`;
całkowity brak pokrycia ma `version: null`. Wyniki są cache'owane przez 24 h.
Nieznany identyfikator zwraca `404 LAYER_NOT_FOUND`; niepoprawne parametry —
`422 VALIDATION_ERROR`.

Planowane kafelki w projekcji biegunowej (jak Moon Trek WMTS) można wygenerować z map PGDA / LOLA i serwować statycznie (CDN). Endpoint `/layers/{layer}/tiles/{z}/{x}/{y}.png` nie jest obecnie zaimplementowany.

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
  "lunarPolarVisibility": { "name": "LOLA Lunar Polar Illumination", "source": "NASA GSFC PGDA", "averagingPeriodYears": 18.6, "coverage": "65-90 degrees north and south", "resolutionM": [60, 120, 240] },
  "validationRefs": ["JPL Horizons DE441 with NASA Moon Trek LOLA horizon", "NASA GSFC PGDA Lunar Polar Illumination"]
}
```

`GET /validation?lat=&lon=&start=2027-01-01` (start jest opcjonalny):

```json
{
  "avgIlluminationPct": { "horizon": 0.0, "pgda": 0.0, "lrocWac": null },
  "earthVisibilityPct": { "horizon": 0.0, "pgda": 0.0 },
  "deltaMaxPts": 0.0,
  "withinTolerance": true,
  "tolerancePts": 5.0,
  "periodStart": "2027-01-01",
  "periodEnd": "2028-01-01",
  "periodDays": 365,
  "samplingStepHours": 1.0,
  "heightM": 0.0,
  "lrocWacNote": "no full-coverage WAC illumination raster available",
  "horizonDemVersion": "LRO_LOLA_DEM_SPole45_100mp_v04",
  "horizonDemResolutionM": 100.0,
  "pgdaVersion": {
    "illumination": "AVGVISIB_75S_120M_201608",
    "earthVisibility": "AVGVISIB_75S_120M_201608_EARTH"
  }
}
```

Wartości `0.0` w przykładzie są placeholderami pokazującymi kształt odpowiedzi.
Horizon liczy udział widocznej tarczy Słońca i widoczność tarczy Ziemi z
efemeryd JPL Horizons oraz maski z LOLA DEM; próbkowanie odbywa się co godzinę
przez pełny rok kalendarzowy. Domyślny przedział to 2027-01-01–2028-01-01;
`periodEnd` jest wyłączny, a `start` pozwala wybrać inny początek roku.
Obserwator Horizons i profil terenu mają tę samą wysokość `heightM: 0`.
`periodDays` wynosi 365 albo 366, zależnie od wybranego roku przestępnego.
PGDA `AVGVISIB` jest średnią z cyklu 18,6 roku, więc różnica względem rocznego
Horizon jest naturalna. `deltaMaxPts` to największa bezwzględna różnica
Horizon–PGDA dla oświetlenia i widoczności Ziemi; `withinTolerance` sprawdza
próg 5 punktów procentowych. Punkty poza zakresem PGDA (|lat| < 65°) zwracają
`422 OUT_OF_PGDA_COVERAGE`; piksele NoData wewnątrz pokrycia dają `null` dla
wartości PGDA, delty i werdyktu. Pełnego rastra oświetlenia LROC WAC nie udało się potwierdzić,
dlatego `lrocWac` pozostaje `null` zamiast zastępować go danymi PGDA.
Punkt PGDA jest próbkowany z tego samego produktu i według tej samej reguły co
warstwy `/layers`, aby wynik walidacji był z nimi zgodny.

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
`sizeKm` przyjmuje `5`, `10`, `20` lub `40`; `res` przyjmuje wartości od `16` do
`512`. Dane pochodzą z DEM LOLA NASA Moon Trek: nominalnie 100 m/px w
polarnych usługach DEM, a globalnie z produktu 256 ppd. Gęstsza siatka wyjściowa
jest interpolowana i nie zwiększa rozdzielczości źródła. Wyniki są cache'owane
w SQLite (maksymalnie 4 heightmapy przez 24 h).

```json
{
  "lat": -89.45, "lon": -137.3,
  "sizeKm": 20, "res": 256,
  "originElevationM": 1912,
  "minElevationM": -12.0, "maxElevationM": 18.0,
  "heightsM": [[-11.8, -11.0, "…"], "…"],
  "northUp": true,
  "demVersion": "LRO_LOLA_DEM_SPole45_100mp_v04",
  "demResolutionM": 100
}
```

- Siatka w układzie lokalnym lądownika (środek = punkt lądowania, góra siatki = północ lokalna); `heightsM` i min/max są wysokościami względem `originElevationM`.
- `png16`: jedna 16-bitowa mapa wysokości (mniejszy transfer). Wartości pikseli 0–65535 mapują liniowo z nagłówków `X-Min-Elevation-M` / `X-Max-Elevation-M`.
- Daleki teren (do 150 km) **nie** idzie tym endpointem — w scenie rysuje go pierścień z `GET /horizon` (§5.6).

### 4.15 `GET /simulations/{id}/brief.pdf` (opcjonalnie)

PDF Mission brief. Na hackathon wystarczy wersja **po stronie frontendu** (`window.print()` z CSS do druku) — ten endpoint dopiero, gdy zostanie czas.

---

## 5. Obliczenia — co dokładnie ma robić backend

### 5.1 Maska horyzontu (LOLA)

1. Obecna implementacja wczytuje polarny DEM NASA Moon Trek 100 m/px. Docelowy DEM PGDA 5/20 m/px nie jest jeszcze podłączony.
2. Dla każdego azymutu (co `binDeg`) rzucaj promień od punktu do **150 km**, próbkując co 100 m (przy biegunie cienie rzucają góry odległe o 100+ km).
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
| Próbki DEM i efemerydy | SQLite (`backend/.cache/`) | współrzędne, wersja DEM i parametry zapytania |
| Profile horyzontu | SQLite (`backend/.cache/`) | `lat, lon, heightM, binDeg, demVersion` |
| Wycinki DEM Moon Trek | pliki GeoTIFF w `backend/.cache/dem-windows/`, maks. 4 przez 24 h | wersja źródła i kafel przestrzenny ~10 km |
| Heightmapy | SQLite (`backend/.cache/`), maks. 48 | `lat, lon, sizeKm, res, demVersion` |
| Siatki PSR | SQLite (`backend/.cache/`) | `lat, lon, sizeKm, res, version` |
| Symulacje | pamięć procesu (maks. 256) i SQLite (maks. 256) | hash znormalizowanego requestu → to samo `id`; TTL SQLite 24 h |
| Kalendarz katalogu | JSON z wyprzedzeniem | `siteId, rok, preset` |

### 6.1 Odporność na wolne źródła NASA (zaimplementowane)

| Mechanizm | Gdzie | Po co |
|---|---|---|
| Dwa pasy do Moon Trek: `light` (4 równoległe) i `bulk` (1) | `sources._get_moon_trek_response(lane=…)` | eksport wycinka DEM 340 km (~38 MB) idzie pasem `bulk` i nie blokuje małych zapytań (wysokość punktu, małe heightmapy, siatki) |
| `single_flight(key)` | `sources.py`; użyte w wycinku DEM, `/horizon`, heightmapie, `/terrain/point`, efemerydach | równoległe zapytania o to samo (symulacja + `/horizon` + `/nearby`, podwójny render frontu) robią **jedno** pobranie; rozłączenie klienta nie przerywa pracy innym |
| Timeouty GDAL (`gdal_http_env()`) + `run_remote_raster()` (45 s) | PSR, siatki PSR i widoczności | odczyty `/vsicurl` z PGDA nie miały timeoutu i potrafiły zawiesić wątek na zawsze — razem z `/terrain/point` |
| Częściowa odpowiedź `/terrain/point` | `sources._fetch_lunar_elevation` | błąd sąsiedniej próbki lub PSR nie kasuje wysokości (`complete: false`) |
| Ponowienia | Moon Trek: 2× (`RemoteProtocolError`, `ReadTimeout`), Horizons: 1× | zerwane połączenia NASA zwykle przechodzą za drugim razem |
| Siatka PSR: NoData = „nie PSR” | `layer_grid_source._sample_psr_dataset` | raster PGDA zawiera tylko piksele PSR; `null` tylko poza zasięgiem rastra. `/nearby` nie wyklucza komórek z `psr = null` |
| Margines wycinka DEM dla heightmapy | `heightmap_source` | wycinek z cache musi pokrywać cały kwadrat (pół przekątnej + 500 m) — wcześniej punkt przy krawędzi dawał fałszywe `OUT_OF_DEM_COVERAGE` |

- Odpowiedzi GET z `ETag` + `Cache-Control: public, max-age=86400` (dane się nie zmieniają).
- Duże tablice w JSON są OK do ~5 MB; przy większych rozważ `gzip` (włączony na serwerze) albo zmniejszenie kroku.

---

## 7. Proponowany stack

- **Python 3.12 + FastAPI** — najlepszy ekosystem do rastrów i astronomii.
- `httpx` (Horizons), `numpy`, `rasterio` (DEM GeoTIFF), `pyproj` (projekcja biegunowa).
- Kolejka async: na hackathon wystarczy `BackgroundTasks` FastAPI + słownik w pamięci; później Redis/RQ.
- Hosting: Render / Fly.io; statyczne kafelki i JSON-y z wyprzedzeniem na CDN.
- Dokumentacja interaktywna za darmo z FastAPI: `/docs` (Swagger) — frontend widzi kontrakt od pierwszego dnia.

### Uruchomienie aktualnego MVP

Backend jest w katalogu `backend/` i wymaga Python 3.10+.

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

API działa pod `http://localhost:8000/api/v1`, a dokumentacja OpenAPI pod
`http://localhost:8000/docs`. Dozwolony origin frontendu można zmienić przez
`FRONTEND_ORIGINS` (lista originów rozdzielona przecinkami).
Testy uruchom poleceniem `python -m pytest` w katalogu `backend/`.

Cache DEM, horyzontu, efemeryd i wyników symulacji jest przechowywany w SQLite
w `backend/.cache/` i przetrwa restart procesu. Lokalizację można zmienić przez
`HORIZON_CACHE_DIR`. Dane źródłowe i symulacje wygasają po 24 godzinach.
Przed demo uruchom w katalogu `backend/`:

```powershell
python -m scripts.warmup
```

Skrypt przygotowuje cztery pierwsze wyróżnione miejsca frontendu dla jego
domyślnej daty symulacji. Miejsca i czas można wskazać jawnie:

```powershell
python -m scripts.warmup --site connecting-ridge --site mons-mouton --landing-time 2027-03-14T06:00:00Z
```

Obecna implementacja udostępnia `GET /health`, `GET /sites`,
`GET /sites/{id}`, `GET /terrain/point`, `GET /terrain/heightmap`,
`GET /horizon`, `GET /ephemeris`, `POST /simulations`,
`GET /simulations/{id}`, `POST /calendar`, `POST /scenarios/compare`,
`POST /nearby`, `GET /layers`, `GET /layers/{id}/grid`, `GET /meta/sources`
i `GET /validation`. Katalog ma te same 19 wpisów co frontend; cztery miejsca
demo sprawdzono w LROC QuickMap i zwracają `coordsVerified: true`.

`/terrain/point` pobiera wartości z NASA Moon Trek ImageServer: DEM biegunowe
LOLA ma rozdzielczość 100 m/px, a globalny DEM 256 px/stopień. Nie jest to
deklarowany w pierwotnym projekcie zestaw PGDA 5 m/px; odpowiedź zwraca
rozdzielczość i identyfikator użytej warstwy. Próbki dla DEM polarnych są
przeliczane do natywnej projekcji stereograficznej Moon2000; DEM globalny
otrzymuje współrzędne geograficzne. Nachylenie jest szacowane z centralnych
różnic wysokości w czterech kierunkach. `inPermanentShadow` jest odczytywane
z mapy PSR PGDA (20 m/px, 80–90°S); poza jej zasięgiem lub w pikselach NoData
zwraca `null`.

Próbki live mapy PSR zweryfikowano: `lat=-88`, `lon=0` zwróciło `true`,
a `lat=-89.45`, `lon=-137.3` zwróciło `false`.

`/horizon` pobiera obraz DEM z NASA Moon Trek ImageServer i zwraca maksymalny
kąt terenu dla każdego azymutu. Pełny promień ma 150 km; pierwsze żądanie jest
wolniejsze z powodu pobrania obrazu, kolejne odpowiedzi z tym samym kluczem
korzystają z cache'u.

`POST /simulations` łączy efemerydy JPL Horizons z maskami terenu, liczy
widoczność tarczy Słońca i Ziemi, okna, baterię oraz ocenę powodzenia według
heurystyki z §5. Wyniki można pobrać przez `GET /simulations/{id}` do czasu
wygaśnięcia cache'u SQLite (24 h) lub usunięcia wpisu z limitowanego cache'u.

`/ephemeris` odpytuje JPL Horizons dla obserwatora na powierzchni Księżyca
(body 301), z modelem airless i DE441. Zakres musi mieć strefę czasową, być
podzielny przez `stepMin` i nie przekraczać 4320 próbek. Odpowiedzi są cache'owane
w SQLite przez 24 godziny. Błędy i timeouty źródeł są zwracane jawnie.
Pozostałe endpointy specyfikacji wymagają dalszej implementacji oraz danych wejściowych.

Sprawdzenie live wykonane 2026-11-14 dla `lat=-89.45`, `lon=-137.3`:
`/terrain/point` pobrał z `LRO_LOLA_DEM_SPole45_100mp_v04` wysokość `1956 m`;
próbki N/S/E/W wyniosły `1954`, `1955.5`, `1953` i `1952.5 m`, dając
nachylenie `0.453°`.
Dla przedziału `2027-03-14T06:00:00Z`–`2027-03-14T06:20:00Z`, krok 10 min,
Horizons zwrócił dla pierwszej próbki Słońce `az=241.197254°`,
`el=-1.097653°`, a Ziemię `az=132.864769°`, `el=5.865464°`.
Wartości są wynikiem zewnętrznych usług NASA/JPL, a nie stałymi testowymi.
Wartość `1318 m` z wcześniejszego pomiaru wynikała z błędnego podania stopni
geograficznych jako metrów projekcji. Współrzędne próbek są teraz przeliczane
do natywnego SR każdego DEM-u. Live sprawdzono projekcję północną względem
GeoTIFF-a; pozostałe regiony i nachylenie wymagają dalszej walidacji na
niezależnych punktach kontrolnych.

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

## 9. Uruchomienie serwera

Wszystkie polecenia wykonuj w PowerShell z katalogu `backend/`.

### Pierwsze uruchomienie

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Jeśli PowerShell blokuje aktywację środowiska, ustaw politykę tylko dla bieżącego
procesu: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`.

### Development

```powershell
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

`--reload` automatycznie restartuje serwer po zmianach kodu. API działa pod
`http://127.0.0.1:8000/api/v1`, health check pod
`http://127.0.0.1:8000/api/v1/health`, a Swagger pod `http://127.0.0.1:8000/docs`.

### Demo

Przed prezentacją rozgrzej cache i uruchom serwer bez `--reload`:

```powershell
python -m scripts.warmup
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Warm-up łączy się z NASA/JPL i może potrwać kilka minut. Nie wymaga
uruchomionego serwera. Cache jest zapisywany domyślnie w `backend/.cache/`;
jeśli ustawiasz `HORIZON_CACHE_DIR`, użyj tej samej wartości podczas warm-upu
i uruchamiania serwera. Katalog musi być zapisywalny i nie może być usuwany,
jeśli cache ma przetrwać restart.

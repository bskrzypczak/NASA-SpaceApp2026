# HORIZON — Lunar landing site planner

Szkielet aplikacji na NASA Space Apps (Vite + React + TypeScript).

## Start

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # produkcyjny build do dist/
```

## Ekrany i trasy

| # | Ekran | Trasa | Co już działa |
|---|---|---|---|
| 1 | Explore | `/` | placeholder tabeli i modelu 3D, szybki wybór miejsca, pasek LAT/LON z walidacją, **Next** → Site |
| 2 | Catalog | `/catalog` | lista 19 miejsc z filtrami programów, **Open** → Site |
| 3 | Site | `/site?lat=..&lon=..` | pokazuje LAT/LON z ekranu 1 lub 2 (z URL), **Start simulation** → popup |
| 4 | Popup potwierdzenia | `/site/confirm?lat=..&lon=..` | modal nad Site: Esc, klik w tło i **Back** zamykają |

Top bar: Explore / Catalog / Site — link Site niesie aktualne współrzędne.

## Model 3D Księżyca (ekran 1)

`src/components/moon/` — react-three-fiber + drei:

- **przeciąganie** obraca, **kółko / pinch** przybliża (wolniejszy obrót przy dużym zoomie, jak w QuickMap), przyciski +/−;
- **klik w powierzchnię** stawia pinezkę i zapisuje LAT/LON w store → pasek pod globusem i ekran Site od razu je widzą;
- białe kropki = miejsca z katalogu (hover pokazuje nazwę, klik wybiera);
- wybór miejsca z listy / katalogu / wpisanie współrzędnych → kamera płynnie obraca się do punktu;
- na dole kursor na żywo: LAT/LON pod myszką.

### Tekstura Księżyca

Pobierz mapę koloru z **NASA SVS CGI Moon Kit** (domena publiczna, NASA/GSFC SVS):
https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg
i zapisz jako `public/textures/moon_color.jpg`. Bez pliku globus działa, ale jest szary (komunikat w rogu).
Większa rozdzielczość (4k/8k) wygląda lepiej przy zoomie, ale wolniej się ładuje.

Lepsza jakość przy zoomie: z https://svs.gsfc.nasa.gov/4720 weź wersję **8k** (TIFF) i skonwertuj, np.
`magick lroc_color_16bit_srgb_8k.tif -depth 8 -quality 90 public/textures/moon_color.jpg`.
16k zwykle przekracza limit tekstury GPU (często 8192 px). Pełna jakość przy każdym zoomie = kafelki WMTS (Moon Trek) — później.

### Gwiaździste niebo

Tło to prawdziwa mapa nieba z **NASA SVS Deep Star Maps** (https://svs.gsfc.nasa.gov/4851) — pobierz wersję 4k JPG
i zapisz jako `public/textures/starmap.jpg`. Jasność tła: `scene.backgroundIntensity` w `Moon3D.tsx` (domyślnie 0.6).
Bez pliku pokazują się proceduralne gwiazdy (drei `<Stars>`).

Konwersja współrzędnych: `src/lib/geo.ts` (`latLonToVector` / `vectorToLatLon`), zgodna z UV `SphereGeometry`
i mapą equirectangular (lewa krawędź = 180° W, góra = 90° N).

## Ekran 3 · Site

- **Mapa — 2 widoki:**
  - *Imagery · LROC* — zbliżenie z góry na tę samą teksturę co globus (północ u góry). Przeciąganie = przesuwanie, kółko = zoom, **klik = przesunięcie pinezki** (aktualizuje LAT/LON, panel i URL). Przycisk ⌖ wraca do pinezki. Przy biegunie tekstura jest mało szczegółowa — od tego jest drugi widok.
  - *Terrain · LOLA* — cieniowana rzeźba z `GET /terrain/heightmap` (5/10/20/40 km, zoom zmienia zakres), pinezka w środku, wysokość pod kursorem.
- **Warstwy mapy** (oświetlenie, widoczność Ziemi, PSR, nachylenie) — pobierane z `GET /layers`; dopóki backend nie poda `tileUrl`, są wyłączone z etykietą „coming soon”.
- **Panel:** edycja LAT/LON (Apply / Enter), wysokość / nachylenie / PSR z `GET /terrain/point` — `null` z backendu = „—”, formularz misji (data UTC + 3/7/14/30 dni, zapisywany w store i pokazywany w popupie), „Start simulation” → popup.

## Ekran 4 · Popup potwierdzenia

- Scena 3D (gwiaździste tło jak na ekranie 1): **Ziemia** z wybranym miejscem startu → trasa → **Księżyc** z miejscem lądowania. Czasy etapów są na „pigułkach”, w środku łączny czas i dystans. Po trasie leci punkt (statek).
- **Trasa alternatywna** na szaro, jak w Google Maps. Klik w jej pigułkę albo przełącznik nad sceną zmienia transfer (Direct ~4 d / Low-energy ~45 d).
- **Wybór miejsca startu**: domyślnie NASA KSC LC-39B, plus Cape Canaveral, Vandenberg, Kourou, Baikonur, Wenchang, Sriharikota, Tanegashima (`src/data/launchSites.ts`, współrzędne przybliżone). Ziemia obraca się tak, by start był widoczny.
- Panel: miejsce lądowania, data startu wyliczona z daty lądowania minus czas transferu, długość misji.
- Czasy etapów to szacunki planistyczne z `src/data/route.ts`. Później zastąpi je `GET /route`.
- Gdy popup jest otwarty, wizytówka nad pinezką na mapie Site jest ukryta.

### Tekstura Ziemi

NASA Blue Marble Next Generation (Topography + Bathymetry), wersja **5400×2700 JPEG**:
https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/topography-bathymetry-maps
Zapisz jako `public/textures/earth_color.jpg`. Bez pliku Ziemia jest jednolicie niebieska.
Credit: „NASA's Earth Observatory”.

## Ekran 5 · Simulation (Basic)

Trasy: `/simulation/new` (uruchamia `POST /simulations` z ustawień z ekranów 1–4) → `/simulation/:id`.

- **Ładowanie:** pierwsza symulacja dla nowego miejsca trwa na backendzie ~40 s (DEM). Pokazujemy kroki i czas. Ponowne wejście korzysta z cache w przeglądarce.
- **Scena 3D:** lądownik, bliski teren i daleka sylwetka z `GET /horizon`, Słońce (kierunek światła) i Ziemia z `timeseries` (az/el), linie widoczności w kolorze werdyktu backendu (żółta / niebieska / czerwona przerywana). Skala pionowa ×10, stosowana tak samo do terenu i ciał (`tan el' = 10·tan el`). Kamery: Orbit / Lander view (rozglądanie się z masztu) / Top-down.
- **Sky 360°:** panorama w prawdziwej skali — oś X azymut, oś Y elewacja, szara maska horyzontu, przerywane tory Słońca i Ziemi.
- **Karty:** elewacja Słońca i Ziemi + zapas nad terenem, odliczanie do zachodu / Earthset (z `events`), bateria z rezerwą.
- **Ocena:** procent, werdykt, 3 czynniki z punktami, „Terrain costs N points” (`flatHorizonSuccessPct`). Przełącznik **Real terrain ↔ Flat horizon** dociąga drugą symulację z `horizonModel: "flat"`.
- **Oś czasu:** play (1 h/s, 6 h/s, 1 d/s), suwak, pasy Sunlight / Earth link / Both z `windows`, wykres baterii z linią rezerwy i końcem misji.
- Miejsca na północ od 80° S: backend nie ma tam DEM → wysyłamy `horizonModel: "flat"` automatycznie.
- **Tryb mock:** `src/lib/simModel.ts` to port 1:1 wzorów z `backend/app/simulation.py` (sprawdzony — te same wyniki na tych samych danych wejściowych).

## Ekran 8 · Compare dates (`/dates`)

Wejścia: „Compare landing dates” na ekranie Site, „Compare dates” i „Find a better date” na ekranie Simulation.

- `POST /calendar` dla dwóch widocznych miesięcy (‹ › przewija). Każdy dzień: szansa powodzenia, kolor + ▼ dla ryzykownych, ★ BEST, YOURS.
- Panel wybranego dnia: wynik, różnica dni względem Twojej daty, porównanie pasków, min. bateria / % Ziemi / najdłuższa noc. **Simulate this date** ustawia datę i uruchamia symulację; **Set as landing date** wraca do Site.
- **12-month outlook** ładowany na żądanie (cały rok liczy się długo). Po załadowaniu miesiące z tego samego roku nie wysyłają już zapytań.
- Wyniki kalendarza są cache'owane w przeglądarce per zapytanie. Kalendarz liczy co godzinę, symulacja co 10 min — dzień może się różnić o 1–2 pkt.
- Pole `season` z backendu celowo nie jest pokazywane (zobacz notatkę dla backendu).

## Backend i tryby API

Skopiuj `.env.example` do `.env.local`:

| Tryb | Ustawienia | Zachowanie |
|---|---|---|
| live | `VITE_API_URL=http://localhost:8000/api/v1` | prawdziwy backend |
| mock | brak URL, `VITE_USE_MOCKS=true` | generowany teren do pracy nad UI — zawsze z plakietką **MOCK DATA** |
| offline | brak URL, `VITE_USE_MOCKS` ≠ true | wartości „—”, komunikat „backend not connected” |

Klient: `src/api/client.ts`, typy odpowiedzi zgodne z `backend/README.md`: `src/api/types.ts`.
Pola, których backend jeszcze nie liczy (`slopeDeg`, `inPermanentShadow`), są typowane jako `| null` i obsłużone w UI.

## Struktura

```
src/
  components/   TopBar, Placeholder, CoordinateBar, Modal
  pages/        ExplorePage, CatalogPage, SitePage, SiteConfirmModal
  store/        selection.ts — wybrany punkt (Zustand), wspólny dla wszystkich ekranów
  lib/          coords.ts — parsowanie, walidacja, formatowanie, query string
  data/         sites.ts — katalog miejsc (współrzędne PRZYBLIŻONE, do weryfikacji w QuickMap)
  styles/       tokens.css (kolory i fonty z brand booka) + global.css
```

## Konwencje

- Współrzędne: szerokość −90…90 (N +), długość −180…180 (E +). Pole LON przyjmuje też 0…360.
- Punkt przechodzi między ekranami **przez URL** (`?lat=&lon=`) i przez store — odświeżenie strony nie gubi wyboru.
- Każdy przyszły komponent ma na ekranie `<Placeholder label=… tag=…>`; podmieniacie go na prawdziwy komponent bez ruszania układu.
- Kolory tylko z `tokens.css`. Neon Yellow (`--accent`) wyłącznie na akcentach. Kontrast tekstu ≥ 4.5:1, przyciski ≥ 44 px.

## Następne kroki

1. `FeaturedSites` na ekranie 1; w `Moon3D` relief z mapy wysokości (`ldem`) jako bumpMap.
2. Rysowanie kafelków warstw na mapie Site, gdy backend zacznie zwracać `tileUrl`; ekran Nearby.
3. `RouteMap` w popupie i ekran Simulation (`/simulation`).
4. Dane: `public/data/<site>.json` z Horizons + maska horyzontu z LOLA.

## Hosting

Statyczny build (`dist/`) na Vercel / Netlify. Na GitHub Pages zamień `BrowserRouter` na `HashRouter` w `src/main.tsx`
albo dodaj przekierowanie 404 → index.html.

## Backend

Specyfikacja API: [backend/README.md](backend/README.md).

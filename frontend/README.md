# HORIZON — Lunar landing site planner

Szkielet aplikacji na NASA Space Apps (Vite + React + TypeScript).

## Start

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # produkcyjny build do dist/
```

## Ekrany i trasy

| # | Ekran | Trasa | Co działa |
|---|---|---|---|
| 1 | Explore | `/` | obracany model 3D Księżyca z pinezką, wyróżnione miejsca, pasek LAT/LON z wysokością, **Next** → Site |
| 2 | Catalog | `/catalog` | 19 miejsc, filtry programów, wyszukiwarka (nazwa / program / region), formularz własnych współrzędnych |
| 3 | Site | `/site?lat=..&lon=..` | mapa (zdjęcia / teren LOLA) z warstwami Slope, PSR, Sunlight, Earth visibility; dane punktu; **Start simulation** |
| 3b | Nearby | `/nearby` | mapa wrażliwości 3×3 i lepsze miejsca w pobliżu |
| 4 | Popup potwierdzenia | `/site/confirm` | trasa Ziemia → Księżyc, wybór kosmodromu |
| 5 | Simulation (Basic) | `/simulation/:id` | scena 3D / Sky 360°, karty Słońce / Ziemia / bateria, oś czasu, wynik misji |
| 6 | Simulation (Pro) | `/simulation/:id?mode=pro` | wykresy, zdarzenia, walidacja vs PGDA, eksport, źródła — patrz niżej |
| 7 | Mission brief | `/simulation/:id/brief` | jedna strona A4 do druku / PDF |
| 8 | Compare dates | `/dates` | kalendarz dni lądowania |
| 9 | Scenarios | `/scenarios` | porównanie 2–4 scenariuszy |

Top bar: Explore / Catalog / Site / Simulation / Dates / Scenarios — link Site niesie aktualne współrzędne.

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
- **Scena 3D:** lądownik, bliski teren i daleka sylwetka z `GET /horizon`, Słońce (kierunek światła) i Ziemia z `timeseries` (az/el), linie widoczności w kolorze werdyktu backendu (żółta / niebieska / czerwona przerywana). Skala pionowa ×10, stosowana tak samo do terenu i ciał (`tan el' = 10·tan el`). Z daleka (Orbit / Overview / Top-down), gdy jest plik `moon_displacement.png`, terenem jest sama kula Księżyca z rzeźbą LOLA ×10 aż do lądowiska — lądownik stoi dokładnie na jej powierzchni, bez osobnego wycinka. Kula to „sześcian napompowany do kuli” (bez zbiegania się siatki na biegunach, gdzie leży większość lądowisk), a tekstura jest próbkowana z kierunku na każdym pikselu. W Lander view (albo bez pliku z rzeźbą) pokazujemy wycinek z `/horizon`: teren to wycinek powierzchni na kuli Księżyca z teksturą, w tej samej skali co kula: poziomo 1:1 (pierścień `R_RING` = `maxDistanceKm`, 150 km), pionowo ×10 — tak samo jak rzeźba całego globu z mapy LOLA. W każdym kierunku blokujący grzbiet stoi w swojej prawdziwej odległości (`distanceKm` z `/horizon`), a lądowisko na swojej prawdziwej wysokości (`observerElevationM`), więc wycinek nie odstaje od kuli. Dwa tryby geometrii: Orbit / Overview / Top-down — rzeźba ×10 na prawdziwej krzywiźnie (pasuje do kuli); Lander view — cała wysokość nad płaszczyzną styczną ×10 (`tan el' = 10·tan el`, jak Słońce i Ziemia), więc sylwetka z lądownika zgadza się z backendem co do kąta (kula jest wtedy ukryta, bo i tak leży pod horyzontem). Światło Słońca ma prawdziwy kierunek i rzuca cienie terenu (grzbiety oświetlone, doliny w cieniu); werdykt „Sunlit / Blocked” dla samego lądownika nadal pochodzi z backendu (karty, kolory linii). Kulę oświetla własny shader od kierunku Słońca. Słońce i Ziemia leżą na „sferze nieba” poza Księżycem — kierunek prawdziwy, odległość nie. Poza Lander view są rysowane ok. 3× większe niż wyszłoby z ich prawdziwych rozmiarów kątowych (Słońce 0,53°, Ziemia ~1,9°), bo obok całego Księżyca byłyby kropkami; w Lander view mają mniejszy, umowny rozmiar. Overview ustawia kamerę tak, żeby w kadrze zmieściły się Księżyc, Słońce i Ziemia. **Overview = układ Ziemia–Księżyc:** Ziemia w środku (prawdziwy rozmiar względem Księżyca), światło Słońca z ustalonego kierunku, Księżyc krąży wokół Ziemi i — w rotacji związanej — zwraca się do niej stale tą samą stroną, więc lądowisko i linie widoczności obracają się razem z nim. Położenie i obrót Księżyca liczymy z prawdziwych (nie przeskalowanych) kierunków do Słońca i Ziemi widzianych z lądowiska: oś obrotu Księżyca → pion sceny, Słońce → +X, Księżyc leży naprzeciw kierunku, w którym widzi Ziemię. Odległość Ziemia–Księżyc jest skrócona (naprawdę ≈ 60 promieni Ziemi), a Słońce to znacznik kierunku (naprawdę ~400× dalej). Pozostałe kamery są w układzie lądowiska.

  **Rzeźba całego globu (opcjonalnie):** kula dostaje tę samą rzeźbę ×10 z mapy wysokości LOLA, więc wycinek terenu nie jest jedynym „guzem” na gładkiej kuli. Plik `public/textures/moon_displacement.png` (8-bit, szarość 0 = −10 km, 255 = +10 km względem 1737,4 km) zrób z `ldem_16_uint.tif` (lepszy z bliska) albo `ldem_4_uint.tif` (mały) z NASA SVS CGI Moon Kit (https://svs.gsfc.nasa.gov/4720):

  ```bash
  magick ldem_16_uint.tif -resize 4096x2048 -level 0,61.035% -depth 8 public/textures/moon_displacement.png
  ```

  (`ldem_*_uint` = półmetry ponad 1727,4 km, więc 40 000 = +10 km ≈ 61,035% zakresu 16 bit.) Bez pliku kula jest gładka, a lądowisko stoi na jej powierzchni. Pod wycinkiem kula jest trzymana na wysokości lądowiska; dalej przejmuje prawdziwa rzeźba.

Kamery: Orbit / Overview (z daleka: makieta + Słońce + Ziemia) / Lander view (rozglądanie się z masztu) / Top-down; oddalanie do 420 jednostek.
- **Sky 360°:** panorama w prawdziwej skali — oś X azymut, oś Y elewacja, szara maska horyzontu, przerywane tory Słońca i Ziemi.
- **Karty:** elewacja Słońca i Ziemi + zapas nad terenem, odliczanie do zachodu / Earthset (z `events`), bateria z rezerwą.
- **Ocena:** procent, werdykt, 3 czynniki z punktami, „Terrain costs N points” (`flatHorizonSuccessPct` z tej samej odpowiedzi — osobnego widoku „flat horizon” już nie ma, bo w scenie 3D niczego nie zmieniał). Przełączniki **3D scene / Sky 360°** i kamery są w prawym górnym rogu sceny; pasek nad sceną ma tylko nawigację i Basic / Pro.
- **Oś czasu:** play (1 h/s, 6 h/s, 1 d/s), suwak, pasy Sunlight / Earth link / Both z `windows`, wykres baterii z linią rezerwy i końcem misji.
- Miejsca na północ od 80° S: backend nie ma tam DEM → wysyłamy `horizonModel: "flat"` automatycznie.
- **Tryb mock:** `src/lib/simModel.ts` to port 1:1 wzorów z `backend/app/simulation.py` (sprawdzony — te same wyniki na tych samych danych wejściowych).

## Ekran 6 · Simulation — tryb Pro (`?mode=pro`)

Przełącznik **Basic / Pro** w pasku symulacji; tryb jest w URL, więc link otwiera ten sam widok. Panel pod osią czasu (`src/components/pro/`):

- **Charts** — trzy wykresy na wspólnej osi dni (`TimeChart.tsx`, czyste SVG): wysokość Słońca vs teren w jego azymucie, to samo dla Ziemi (szare pole = horyzont terenu, zacienione pasy = okna widoczności z backendu), stan baterii z linią rezerwy. Najechanie = tooltip z wartościami, kliknięcie = przesuwa zegar symulacji (scena 3D i karty się aktualizują). Kolory ciał jak w scenie (Słońce żółte, Ziemia niebieska); każdy wykres ma legendę, a wartości są w tooltipie, więc kolor nie jest jedynym nośnikiem informacji.
- **Events** — wszystkie wschody / zachody Słońca i Ziemi, bateria na rezerwie, koniec misji; czas UTC, dzień, azymut, wysokość; **Go →** przenosi zegar.
- **Validation vs PGDA** — `GET /validation` (tylko 65–90° N/S): średni czas w słońcu i z Ziemią w zasięgu z naszego modelu (rok, co godzinę) vs mapy NASA PGDA (18,6 roku), różnica i werdykt w tolerancji ±5 pkt. Uruchamiane przyciskiem (pierwszy raz może trwać ok. minuty).
- **Data & export** — pobranie pełnego wyniku (JSON) i szeregu czasowego (CSV), kopiowanie linku, założenia modelu (bateria, panele, obciążenia, wagi wyniku) i źródła danych z `GET /meta/sources`.

## Ekran 7 · Mission brief (`/simulation/:id/brief`)

Biała strona A4 (na ekranie jak kartka, w druku bez paska aplikacji): miejsce i wynik z werdyktem, parametry misji i sprzętu, sześć kluczowych liczb, pasek widoczności Słońca / Ziemi i wykres baterii przez całe okno, cztery „readiness checks” (bateria nad rezerwą, najdłuższa noc vs zapas energii, łączność z Ziemią, Słońce przy lądowaniu), rozbicie wyniku na czynniki, zdarzenia w trakcie misji i źródła. **Print / Save as PDF** = `window.print()` z CSS `@media print` (`MissionBriefPage.css`); backendowy `brief.pdf` nie jest potrzebny.

## Ekran 8 · Compare dates (`/dates`)

Wejścia: „Compare landing dates” na ekranie Site, „Compare dates” i „Find a better date” na ekranie Simulation.

- `POST /calendar` dla dwóch widocznych miesięcy (‹ › przewija). Każdy dzień: szansa powodzenia, kolor + ▼ dla ryzykownych, ★ BEST, YOURS.
- Panel wybranego dnia: wynik, różnica dni względem Twojej daty, porównanie pasków, min. bateria / % Ziemi / najdłuższa noc. **Simulate this date** ustawia datę i uruchamia symulację; **Set as landing date** wraca do Site.
- **12-month outlook** ładowany na żądanie (cały rok liczy się długo). Po załadowaniu miesiące z tego samego roku nie wysyłają już zapytań.
- Wyniki kalendarza są cache'owane w przeglądarce per zapytanie. Kalendarz liczy co godzinę, symulacja co 10 min — dzień może się różnić o 1–2 pkt.
- Pole `season` z backendu celowo nie jest pokazywane (zobacz notatkę dla backendu).

## Ekran 9 · Scenarios (`/scenarios`)

Wejścia: zakładka **Scenarios** w top barze, „Scenarios” na ekranie Simulation, „+ Add to comparison” w kalendarzu.

- Lista 2–4 scenariuszy (pierwszy = baseline z bieżącego wyboru). Szybkie dodawanie: **Slip +1/+2/+4 wk**, **inne miejsce z katalogu** (ta sama data), **bieżący wybór**. Nazwy edytowalne (unikalność pilnujemy przy wysyłce).
- **Wymagania**: min. bateria i min. % Ziemi → `requirements` w `POST /scenarios/compare`.
- Wynik: kolumny ze szansą, werdyktem, różnicą do baseline, ✓/! przy metrykach z wymagań, „Open simulation” (wynik z backendu po `simulationId`); pasy okien pracy (Sun+Earth / Sun / Earth / dark) z kreską końca misji; **rekomendacja** backendu (reguła: najlepszy spełniający wymagania, przy różnicy < 3 pkt wygrywa bez zmiany daty).
- Po zmianie listy wyniki są oznaczane jako nieaktualne do ponownego „Compare”. Wyniki cache'owane per zapytanie.

## Lądownik (parametry zasilania)

Bateria, panele i pobory decydują o krzywej baterii i o wyniku, więc są jawne i edytowalne.

- Presety w `src/lib/landers.ts`, każdy z opisem źródeł:
  - **Reference lander (VIPER-class)** (domyślny): 5,4 kWh, 450 W, 200 W dzień, 80 W noc. Bateria i panele z danych NASA VIPER, pobory założone.
  - **Small CLPS lander (Nova-C-class)**: 0,7 kWh, 200 W. Lądownik na jeden dzień księżycowy, padnie przy pierwszej długiej nocy.
  - **Night-survival concept (20 kWh)**: poprzednie wartości domyślne, hipotetyczne.
- Edycja: **Pro → Lander** (albo klik „⚡ …” w ramce miejsca na scenie). Pola z jednostkami, wyliczone: ile godzin ciemności starczy baterii (z ostrzeżeniem, gdy mniej niż najdłuższa noc), nadwyżka w słońcu, czas doładowania.
- „Re-run with this lander” przelicza tę misję i zapisuje sprzęt w `useSelection().hardware`. Od tej chwili idzie on też do Dates, Nearby i Scenarios. Mission brief i Pro → Data pokazują nazwę lądownika.

## Luna — asystentka AI

Przycisk z avatarem Luny otwiera panel z gotowymi pytaniami. Każde pytanie to osobny prompt na backendzie (`POST /luna`, opis w `backend/README.md` §10), a odpowiedź spływa na żywo.

| Ekran | Gdzie jest przycisk | Pytania |
|---|---|---|
| Site | avatar obok nazwy miejsca | „What happened here?” (miejsca misji) / „Tell me about this place” |
| Simulation | prawy dolny róg sceny 3D | „Why this score?”, „Worst moment of the mission”, „What blocks the Sun?” — dwa ostatnie przewijają oś czasu do opisywanego momentu |
| Scenarios | pływający przycisk w rogu ekranu | „Why does X win?”, „Slip the date or move the site?” (aktywne po Compare) |

- Kod: `src/components/luna/` (komponent, style, avatar `luna-avatar.svg`: podmień plik lub import, żeby użyć zdjęcia), klient strumienia `src/api/luna.ts`.
- Pod odpowiedzią widać źródło: „AI · model”, „Built-in summary (AI offline)” (backend bez klucza) albo „Mock answer”.
- Tryb mock: przykładowe odpowiedzi, bez backendu. Klucz API jest tylko na backendzie (`backend/.env`), nigdy we froncie.

## Backend i tryby API

Skopiuj `.env.example` do `.env.local`:

| Tryb | Ustawienia | Zachowanie |
|---|---|---|
| live | `VITE_API_URL=http://localhost:8000/api/v1` | prawdziwy backend |
| mock | brak URL, `VITE_USE_MOCKS=true` | generowany teren do pracy nad UI — zawsze z plakietką **MOCK DATA** |
| offline | brak URL, `VITE_USE_MOCKS` ≠ true | wartości „—”, komunikat „backend not connected” |

Klient: `src/api/client.ts` (funkcje endpointów) + `src/api/http.ts` (transport), typy odpowiedzi zgodne z `backend/README.md`: `src/api/types.ts`.

### Transport (`src/api/http.ts`)

| Mechanizm | Zachowanie |
|---|---|
| Timeout każdego zapytania | `TIMEOUT.short` 45 s, teren/siatki 150 s, `/horizon` i symulacja 300 s, kalendarz/scenariusze/nearby 420 s. Po czasie: `ApiError('CLIENT_TIMEOUT')` zamiast wiecznego „…” |
| Wspólne zapytania GET | identyczne GET-y w locie (np. podwójny efekt StrictMode, Explore → Site dla tego samego punktu) idą do backendu **raz**; anulowanie przez jednego odbiorcę nie przerywa pozostałym |
| Cache GET | udane odpowiedzi przez 5 min (maks. 120); `cacheIf` pomija odpowiedzi częściowe (`/terrain/point` z `complete: false`); `clearApiCache()` czyści |
| Ponowienia | GET: 1× przy błędzie sieci i 502/503/504 (czeka `retryAfterS`, 1–5 s). POST: domyślnie bez, `/simulations` i `/nearby` 1× (są idempotentne) |
| Błędy | `NETWORK` (backend nie działa), `CLIENT_TIMEOUT`, albo kod z backendu (`UPSTREAM_ERROR`, `TIMEOUT`, …) |

`useApi(fn, deps, { debounceMs })` czyści dane przy zmianie parametrów (stara wysokość nie wisi przy nowym punkcie) i opcjonalnie czeka, aż użytkownik przestanie klikać — Explore, Site i mapa terenu używają 300 ms.
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

1. Wdrożenie (frontend statycznie, backend z cache `backend/.cache` i rozgrzaniem `python -m scripts.warmup`).
2. Przegląd dostępności (klawiatura, czytnik ekranu) i widoku mobilnego na wszystkich ekranach.
3. Materiały do zgłoszenia: nagranie demo, opis projektu, slajdy.

## Hosting

Statyczny build (`dist/`) na Vercel / Netlify. Na GitHub Pages zamień `BrowserRouter` na `HashRouter` w `src/main.tsx`
albo dodaj przekierowanie 404 → index.html.

## Backend

Specyfikacja API: [backend/README.md](backend/README.md).

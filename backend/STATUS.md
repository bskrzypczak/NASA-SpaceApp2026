# Status backendu

Aktualizacja: 2026-11-14

## Zrobione

- Utworzono backend FastAPI z endpointami `/health`, `/api/v1/sites`,
  `/api/v1/sites/{id}`, `/api/v1/terrain/point`, `/api/v1/terrain/heightmap`,
  `/api/v1/horizon`, `/api/v1/ephemeris`, `/api/v1/simulations`,
  `/api/v1/simulations/{id}`, `/api/v1/calendar`,
  `/api/v1/scenarios/compare`, `/api/v1/layers` i `/api/v1/meta/sources`.
- Rozdzielono routery symulacji i kalendarza od konfiguracji aplikacji oraz
  wydzielono obliczenia heightmapy i horyzontu do osobnych modułów źródeł.
  Żaden plik Python w `backend/app` nie przekracza 700 linii.
- Dodano katalog 19 miejsc zgodny z frontendem. Ich współrzędne są nadal
  przybliżone (`coordsVerified: false`).
- Podłączono rzeczywiste źródła: DEM LOLA przez NASA Moon Trek oraz efemerydy
  z JPL Horizons (DE441). Odpowiedzi są cache'owane, a błędy źródeł zgłaszane.
- Poprawiono próbkowanie DEM w `/terrain/point`: biegunowe usługi Moon Trek
  otrzymują współrzędne w natywnej projekcji stereograficznej, a globalna
  usługa współrzędne geograficzne. Wcześniej stopnie lon/lat były podawane
  jako metry w `sr=104903`.
- Dodano obliczanie nachylenia z próbek wysokości na północ, południe, wschód
  i zachód. Wzór ma test jednostkowy.
- Dodano `GET /api/v1/horizon`: profil 360° z rzeczywistego DEM Moon Trek,
  promień do 150 km, próbki co 100 m, korekta krzywizny Księżyca oraz obsługa
  `binDeg=0.5` i `binDeg=0.1`. Usługa i projekcja DEM dobierane są według
  szerokości (południowa/północna polarna lub globalna); odpowiedź zawiera
  wersję i rozdzielczość wybranego DEM. Etykiety `features` pozostają puste.
- Live smoke globalnego profilu dla `(0, 0)` zwrócił DEM
  `LRO_LOLA_DEM_Global_256ppd_v06` i nominalne `118.5 m/px`.
- Dodano `GET /api/v1/terrain/heightmap`: rzeczywista lokalna siatka north-up,
  wysokości względem punktu lądowania oraz format JSON/PNG16. Endpoint wybiera
  odpowiednią usługę LOLA Moon Trek (polarną lub globalną), zgłasza brak
  pokrycia DEM i cache'uje maksymalnie 4 mapy.
- Dodano `POST /api/v1/simulations` i `GET /api/v1/simulations/{id}`:
  rzeczywiste efemerydy łączone są z maską horyzontu, widocznością tarcz,
  oknami, zdarzeniami, baterią i oceną powodzenia. Obsługiwane są tryby `real`
  i `flat`; `includeTimeseries: false` ogranicza wielkość odpowiedzi.
- Metryki widoczności misji (`sunlitPct`, `earthVisiblePct`, `bothPct`) liczą
  próbki do końca misji, włącznie z próbką na granicy, nawet gdy okno symulacji
  jest dłuższe; `bothPct` nie przekracza metryk widoczności składowych.
- Błędy źródeł zewnętrznych są logowane po stronie serwera wraz z tracebackiem
  oryginalnego wyjątku; odpowiedzi API nadal nie ujawniają szczegółów wewnętrznych.
- Dodano `POST /api/v1/calendar`: ocena kolejnych dni lądowania tym samym
  silnikiem co symulacje, grupowanie wyników w miesiące, dzień najlepszy,
  godzinowe próbkowanie Horizons i porcjowanie długich zakresów do limitu
  4320 próbek. Miesięczne agregaty nie zawierają niezweryfikowanej etykiety
  pory roku.
- Dodano `POST /api/v1/scenarios/compare`: uruchamia 2–4 zapisane symulacje,
  porównuje progi zapasu energii i widoczności Ziemi oraz wybiera rekomendację
  z preferencją daty bazowej przy różnicy wyniku mniejszej niż 3 pkt.
- Cache DEM, heightmap, horyzontu i efemeryd oraz wyniki symulacji są
  przechowywane w SQLite (`backend/.cache/`) i przetrwają restart serwera.
  `HORIZON_CACHE_DIR` pozwala wskazać inny katalog; cache danych źródłowych i
  symulacji wygasa po 24 godzinach.
- Wyniki symulacji mają deterministyczne ID; zapis pamięciowy jest ograniczony
  do 256 wpisów, a zapis dyskowy jest odtwarzany przy kolejnym żądaniu.
- Dodano skrypt `python -m scripts.warmup`, który przygotowuje DEM, horyzont i
  domyślne symulacje dla czterech pierwszych wyróżnionych miejsc frontendu.
  Uruchomienie produkcyjne skryptu wymaga dostępu do źródeł NASA/JPL.
- Dodano `GET /api/v1/layers/{id}/grid` dla `slope` i `psr`. Siatka nachylenia
  używa metody Horna na tych samych próbkach heightmapy; PSR jest próbkowane z
  rastra PGDA dla środków dokładnie tych samych komórek. Heightmapa używana
  przez slope i siatka PSR są cache'owane na dysku; pozostałe dwie warstwy
  zwracają `LAYER_GRID_UNAVAILABLE`.
- Rasterio 1.4.4 działa w `C:\Users\joasi\Documents\PP\SEM_2\.venv`.
  Podłączono odczyt wartości `inPermanentShadow` z rastra PSR PGDA (20 m/px,
  80–90°S); piksele NoData i punkty poza zasięgiem pozostają `null`. Live
  sprawdzono wynik `true` dla `(-88, 0)` i `false` dla `(-89.45, -137.3)`.
- Testy backendu po dodaniu endpointu siatki: `72 passed`, 1 ostrzeżenie
  deprecacyjne Starlette/httpx.
- Live dla `(-89.45, -137.3)`: DEM zwrócił wysokość `1956 m`, próbki N/S/E/W
  `1954`, `1955.5`, `1953` i `1952.5 m`, a nachylenie `0.453°`.
  Projekcję północną sprawdzono dodatkowo względem wartości z eksportu GeoTIFF.
- Live `/horizon` dla `(-89.45, -137.3)`: HTTP 200, 720 binów, DEM
  `LRO_LOLA_DEM_SPole45_100mp_v04`, zakres kątów `-2.845°`–`0.013°`.
  Pierwsze pobranie obrazu w tym smoke teście trwało około 42 s.
- Trwały cache zweryfikowano testami: po wyczyszczeniu cache RAM wpis źródłowy
  został odczytany z SQLite, a `GET /simulations/{id}` odtworzył wynik po
  opróżnieniu słownika procesu.
- Live `/layers/slope/grid` dla `(-89.45, -137.3)`, `sizeKm=5`, `res=16`:
  HTTP 200, siatka 16×16, 196 komórek z obliczonym nachyleniem, zakres
  `0.749°`–`19.417°`, DEM `LRO_LOLA_DEM_SPole45_100mp_v04`.
- Live `/layers/psr/grid` dla tego samego punktu i rozmiaru: 256 komórek
  pokrytych rastrem PGDA, wartości 0–1, w tym 4 komórki PSR.
- Live `/terrain/heightmap`: HTTP 200 dla DEM południowego, północnego i
  globalnego; domyślna siatka południowa ma 256×256 próbek. JSON i PNG16
  zweryfikowano osobno. Na punkcie `(-89.45, -137.3)` interpolowane
  `originElevationM` wyniosło `1954.71 m`; różnica względem próbkowania
  `/terrain/point` (`1956 m`) wynika z interpolacji rastra o nominalnej
  rozdzielczości 100 m/px.
- Live `/calendar`: JPL Horizons zwrócił HTTP 200 dla dwudniowego zakresu
  smoke test; pełny rok i 3-częściowy podział limitu przeszły test mockowany.
- Live `/scenarios/compare`: HTTP 200 dla dwóch wariantów; efemerydy były
  rzeczywiste z JPL, DEM zastąpiono w smoke teście danymi testowymi, a oba
  wyniki zostały zapisane pod zwróconymi `simulationId`.
- Live test symulacji: `POST` zwrócił 201, a `GET /simulations/{id}` tę samą
  odpowiedź. Krótki test 1-dniowy z krokiem 12 h zajął około 38 s (pierwszy
  odczyt DEM); nie jest to reprezentatywny wynik naukowy dla pełnej misji.

## Do zrobienia

- Uzupełnić `GET /layers/{id}/grid` o `illumination` i `earth-visibility`
  z danych PGDA.
- Następnie `POST /nearby`: mapa wrażliwości małych zmian położenia; ograniczyć
  liczbę komórek lub uruchamiać obliczenia asynchronicznie.
- Następnie `/validation`: porównać średnie oświetlenie z obliczeń backendu,
  PGDA i LROC oraz zwrócić jedną liczbę do prezentacji.
- Zweryfikować współrzędne czterech miejsc demo na niezależnym źródle i dopiero
  wtedy ustawić im `coordsVerified: true`.
- Kafelki mapowe (`/layers/{layer}/tiles/...`) nadal nie są serwowane; aktualny
  kontrakt warstw opiera się na siatkach `/layers/{id}/grid`.
- Zweryfikować wysokości i nachylenie na kolejnych niezależnych punktach
  kontrolnych oraz podłączyć planowany DEM PGDA 5/20 m/px.

## Ograniczenia obecnej wersji

- DEM Moon Trek ma rozdzielczość 100 m/px w obszarach polarnych i około
  118.5 m/px na równiku w usłudze globalnej; nie jest to deklarowany w
  projekcie DEM PGDA 5/20 m/px.
- Heightmapa używa tego samego DEM Moon Trek; większe `res` interpoluje źródło,
  ale nie dodaje szczegółów. Raster PGDA 5/20 m/px pozostaje niepodłączony.
- Pierwsze żądanie `/horizon` pobiera duży obraz DEM i może trwać kilkadziesiąt
  sekund; warm-up pozwala wypełnić trwały cache przed prezentacją.
- Symulacje wykonują się synchronicznie; tryb z nowym profilem horyzontu może
  trwać kilkadziesiąt sekund. Wyniki są cache'owane na dysku przez 24 godziny.
- Kalendarz wykonuje się synchronicznie; pierwsze żądanie obejmujące rok może
  wymagać kilku zapytań do Horizons i potrwać długo.
- Porównanie scenariuszy uruchamia symulacje synchronicznie; warianty z nowym
  profilem DEM mogą trwać kilkadziesiąt sekund.
- Pierwszy odczyt rastra PSR może trwać dłużej; jego GeoTIFF waży około 154 MB,
  a czas odczytu zależy od dostępności serwera PGDA.

# Status backendu

Aktualizacja: 2026-11-14

## Zrobione

- Utworzono backend FastAPI z endpointami `/health`, `/api/v1/sites`,
  `/api/v1/sites/{id}`, `/api/v1/terrain/point`, `/api/v1/terrain/heightmap`,
  `/api/v1/horizon`, `/api/v1/ephemeris`, `/api/v1/simulations`,
  `/api/v1/simulations/{id}` i `/api/v1/meta/sources`.
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
  `binDeg=0.5` i `binDeg=0.1`. Zwracane są wersja i nominalna rozdzielczość DEM;
  etykiety `features` pozostają puste.
- Dodano `GET /api/v1/terrain/heightmap`: rzeczywista lokalna siatka north-up,
  wysokości względem punktu lądowania oraz format JSON/PNG16. Endpoint wybiera
  odpowiednią usługę LOLA Moon Trek (polarną lub globalną), zgłasza brak
  pokrycia DEM i cache'uje maksymalnie 4 mapy.
- Dodano `POST /api/v1/simulations` i `GET /api/v1/simulations/{id}`:
  rzeczywiste efemerydy łączone są z maską horyzontu, widocznością tarcz,
  oknami, zdarzeniami, baterią i oceną powodzenia. Obsługiwane są tryby `real`
  i `flat`; `includeTimeseries: false` ogranicza wielkość odpowiedzi.
- Wyniki symulacji mają deterministyczne ID i są dostępne w pamięci procesu
  (maksymalnie 256 wpisów); nie przetrwają restartu serwera.
- Rasterio 1.4.4 działa w `C:\Users\joasi\Documents\PP\SEM_2\.venv`.
  Podłączono odczyt wartości `inPermanentShadow` z rastra PSR PGDA (20 m/px,
  80–90°S); piksele NoData i punkty poza zasięgiem pozostają `null`. Live
  sprawdzono wynik `true` dla `(-88, 0)` i `false` dla `(-89.45, -137.3)`.
- Testy backendu: `42 passed`.
- Live dla `(-89.45, -137.3)`: DEM zwrócił wysokość `1956 m`, próbki N/S/E/W
  `1954`, `1955.5`, `1953` i `1952.5 m`, a nachylenie `0.453°`.
  Projekcję północną sprawdzono dodatkowo względem wartości z eksportu GeoTIFF.
- Live `/horizon` dla `(-89.45, -137.3)`: HTTP 200, 720 binów, DEM
  `LRO_LOLA_DEM_SPole45_100mp_v04`, zakres kątów `-2.845°`–`0.013°`.
  Pierwsze pobranie obrazu trwało około 42 s; cache jest w pamięci procesu.
- Live `/terrain/heightmap`: HTTP 200 dla DEM południowego, północnego i
  globalnego; domyślna siatka południowa ma 256×256 próbek. JSON i PNG16
  zweryfikowano osobno. Na punkcie `(-89.45, -137.3)` interpolowane
  `originElevationM` wyniosło `1954.71 m`; różnica względem próbkowania
  `/terrain/point` (`1956 m`) wynika z interpolacji rastra o nominalnej
  rozdzielczości 100 m/px.
- Live test symulacji: `POST` zwrócił 201, a `GET /simulations/{id}` tę samą
  odpowiedź. Krótki test 1-dniowy z krokiem 12 h zajął około 38 s (pierwszy
  odczyt DEM); nie jest to reprezentatywny wynik naukowy dla pełnej misji.

## Do zrobienia

- Jeśli frontend potrzebuje nakładki mapowej PSR, uzgodnić i dodać endpoint
  warstw/kafelków. Obecnie endpointów `/layers` ani `/layers/{layer}/tiles/...`
  nie ma.
- Zweryfikować wysokości i nachylenie na kolejnych niezależnych punktach
  kontrolnych; obecnie live sprawdzono jeden punkt na biegunie południowym.
- Zweryfikować współrzędne katalogu miejsc.
- Podłączyć planowany DEM PGDA 5/20 m/px; obecny profil horyzontu korzysta
  z DEM Moon Trek 100 m/px.
- Zaimplementować pozostałe endpointy opisane w specyfikacji, m.in. kalendarz,
  porównanie scenariuszy i warstwy, jeśli nadal należą do zakresu.

## Ograniczenia obecnej wersji

- DEM Moon Trek ma rozdzielczość 100 m/px w obszarach polarnych; nie jest to
  deklarowany w projekcie DEM PGDA 5/20 m/px.
- Heightmapa używa tego samego DEM Moon Trek; większe `res` interpoluje źródło,
  ale nie dodaje szczegółów. Raster PGDA 5/20 m/px pozostaje niepodłączony.
- Pierwsze żądanie `/horizon` pobiera duży obraz DEM i może trwać kilkadziesiąt
  sekund. Cache działa w pamięci procesu.
- Symulacje wykonują się synchronicznie; tryb z nowym profilem horyzontu może
  trwać kilkadziesiąt sekund. Zapis wyników jest tylko w pamięci procesu.
- Pierwszy odczyt rastra PSR może trwać dłużej; jego GeoTIFF waży około 154 MB,
  a czas odczytu zależy od dostępności serwera PGDA.

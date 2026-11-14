# Status backendu

Aktualizacja: 2026-11-14

## Zrobione

- Utworzono backend FastAPI z endpointami `/health`, `/api/v1/sites`,
  `/api/v1/sites/{id}`, `/api/v1/terrain/point`, `/api/v1/ephemeris` i
  `/api/v1/meta/sources`.
- Dodano katalog 19 miejsc zgodny z frontendem. Ich współrzędne są nadal
  przybliżone (`coordsVerified: false`).
- Podłączono rzeczywiste źródła: DEM LOLA przez NASA Moon Trek oraz efemerydy
  z JPL Horizons (DE441). Odpowiedzi są cache'owane, a błędy źródeł zgłaszane.
- Dodano obliczanie nachylenia z próbek wysokości na północ, południe, wschód
  i zachód. Wzór ma test jednostkowy.
- Dodano `GET /api/v1/horizon`: profil 360° z rzeczywistego DEM Moon Trek,
  promień do 150 km, próbki co 100 m, korekta krzywizny Księżyca oraz obsługa
  `binDeg=0.5` i `binDeg=0.1`. Zwracane są wersja i nominalna rozdzielczość DEM;
  etykiety `features` pozostają puste.
- Rasterio 1.4.4 działa w `C:\Users\joasi\Documents\PP\SEM_2\.venv`.
  Podłączono odczyt wartości `inPermanentShadow` z rastra PSR PGDA (20 m/px,
  80–90°S); piksele NoData i punkty poza zasięgiem pozostają `null`. Live
  sprawdzono wynik `true` dla `(-88, 0)` i `false` dla `(-89.45, -137.3)`.
- Testy backendu: `21 passed`.
- Live `/horizon` dla `(-89.45, -137.3)`: HTTP 200, 720 binów, DEM
  `LRO_LOLA_DEM_SPole45_100mp_v04`, zakres kątów `-2.845°`–`0.013°`.
  Pierwsze pobranie obrazu trwało około 42 s; cache jest w pamięci procesu.

## Do zrobienia

- Jeśli frontend potrzebuje nakładki mapowej PSR, uzgodnić i dodać endpoint
  warstw/kafelków. Obecnie endpointów `/layers` ani `/layers/{layer}/tiles/...`
  nie ma.
- Zweryfikować nachylenie na znanych punktach. W jednym pomiarze live wszystkie
  pięć próbek miało wysokość 1318 m, więc wynik wyniósł 0°; test potwierdza
  wzór, nie dokładność tego pomiaru terenowego.
- Zweryfikować współrzędne katalogu miejsc.
- Podłączyć planowany DEM PGDA 5/20 m/px; obecny profil horyzontu korzysta
  z DEM Moon Trek 100 m/px.
- Zaimplementować pozostałe endpointy opisane w specyfikacji, m.in. symulacje
  i kalendarz, jeśli nadal należą do zakresu projektu.
- Poprawić SR w istniejącym `/terrain/point`: zapytanie DEM wysyła lon/lat
  w stopniach z `sr=104903` (metry stereograficzne). Dla `(-89.45, -137.3)`
  stare zapytanie zwróciło 1318 m, a zapytanie w prawidłowych współrzędnych
  projekcji zwróciło 1956 m. To osobny, niewłączony do `/horizon` problem;
  nachylenie wymaga ponownej walidacji po poprawce.

## Ograniczenia obecnej wersji

- DEM Moon Trek ma rozdzielczość 100 m/px w obszarach polarnych; nie jest to
  deklarowany w projekcie DEM PGDA 5/20 m/px.
- Pierwsze żądanie `/horizon` pobiera duży obraz DEM i może trwać kilkadziesiąt
  sekund. Cache działa w pamięci procesu.
- Pierwszy odczyt rastra PSR może trwać dłużej; jego GeoTIFF waży około 154 MB,
  a czas odczytu zależy od dostępności serwera PGDA.

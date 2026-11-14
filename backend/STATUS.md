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
- Rasterio 1.4.4 działa w `C:\Users\joasi\Documents\PP\SEM_2\.venv`.
  Podłączono odczyt wartości `inPermanentShadow` z rastra PSR PGDA (20 m/px,
  80–90°S); piksele NoData i punkty poza zasięgiem pozostają `null`. Live
  sprawdzono wynik `true` dla `(-88, 0)` i `false` dla `(-89.45, -137.3)`.
- Ostatnie uruchomienie testów backendu: `15 passed`.

## Do zrobienia

- Jeśli frontend potrzebuje nakładki mapowej PSR, uzgodnić i dodać endpoint
  warstw/kafelków. Obecnie endpointów `/layers` ani `/layers/{layer}/tiles/...`
  nie ma.
- Zweryfikować nachylenie na znanych punktach. W jednym pomiarze live wszystkie
  pięć próbek miało wysokość 1318 m, więc wynik wyniósł 0°; test potwierdza
  wzór, nie dokładność tego pomiaru terenowego.
- Zweryfikować współrzędne katalogu miejsc.
- Zaimplementować pozostałe endpointy opisane w specyfikacji, m.in. symulacje,
  maskę horyzontu i kalendarz, jeśli nadal należą do zakresu projektu.

## Ograniczenia obecnej wersji

- DEM Moon Trek ma rozdzielczość 100 m/px w obszarach polarnych; nie jest to
  deklarowany w projekcie DEM PGDA 5 m/px.
- Pierwszy odczyt rastra PSR może trwać dłużej; jego GeoTIFF waży około 154 MB,
  a czas odczytu zależy od dostępności serwera PGDA.

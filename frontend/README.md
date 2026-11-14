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
2. `SiteMap` z warstwami i `MissionForm` (data + długość misji) na ekranie 3.
3. `RouteMap` w popupie i ekran Simulation (`/simulation`).
4. Dane: `public/data/<site>.json` z Horizons + maska horyzontu z LOLA.

## Hosting

Statyczny build (`dist/`) na Vercel / Netlify. Na GitHub Pages zamień `BrowserRouter` na `HashRouter` w `src/main.tsx`
albo dodaj przekierowanie 404 → index.html.

## Backend

Specyfikacja API: [backend/README.md](backend/README.md).

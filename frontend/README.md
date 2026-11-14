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

1. `FeaturedSites` i `Moon3D` (react-three-fiber + drei) na ekranie 1.
2. `SiteMap` z warstwami i `MissionForm` (data + długość misji) na ekranie 3.
3. `RouteMap` w popupie i ekran Simulation (`/simulation`).
4. Dane: `public/data/<site>.json` z Horizons + maska horyzontu z LOLA.

## Hosting

Statyczny build (`dist/`) na Vercel / Netlify. Na GitHub Pages zamień `BrowserRouter` na `HashRouter` w `src/main.tsx`
albo dodaj przekierowanie 404 → index.html.

## Backend

Specyfikacja API: [backend/README.md](backend/README.md).

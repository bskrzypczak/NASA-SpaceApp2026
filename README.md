# 🌘 HORIZON
 
### See the Moon's horizon before you land on it.
 
**A lunar landing-site planner for everyone, from curious students to mission planners.**
Built for the NASA Space Apps Challenge.
 
---
 
On the Moon there is no dusk. At the south pole the Sun skims just a few degrees above the horizon, so a ridge tens of kilometres away can cut a lander's power for days. Earth can drop out of sight and take communication with it. **Move the landing a few hundred metres or a few days, and the mission goes from thriving to frozen.**
 
HORIZON turns that complexity into answers in seconds.
 
<!-- Screenshot: save it as docs/simulation.png -->
<p align="center">
  <img src="docs/simulation.png" alt="HORIZON simulation: the Sun skimming a polar ridge, with countdowns to sunset and Earthset" width="900">
</p>

## ✨ What it does
 
- 🗺️ **Pick a site.** Choose from Apollo, Artemis III candidates, CLPS, Chandrayaan, Chang'e and SLIM landing sites, or enter your own coordinates.
- ☀️ **Simulate the mission in 3D.** Sun and Earth positions come from JPL Horizons, and the real terrain horizon is computed from LOLA data. The app counts down to sunset and Earthset, simulates the battery and gives a success score.
- 📅 **Find the best date.** A calendar ranks landing days, and scenario comparison answers the real question: slip the date or move the site?
- 🔬 **Go Pro.** Charts, validation against NASA PGDA maps, CSV export and your own lander specs (battery, solar array, power loads).
- 📄 **Mission brief.** The decision on one printable page.
- 🌙 **Ask Luna.** An AI guide that explains every result in plain language and tells the story of each landing site.
- **Data:** NASA JPL Horizons (DE441) · LRO LOLA via NASA Moon Trek · NASA GSFC PGDA · LROC · NASA SVS
 
## 🚀 Run it locally
 
You need **Python 3.11+** and **Node.js 18+**.
 
### 1. Backend (FastAPI)
 
```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env               # optional: add GROQ_API_KEY to enable Luna's AI answers
uvicorn app.main:app --reload --port 8000
```
 
Optional: warm the cache before a demo with `python -m scripts.warmup`.
 
### 2. Frontend (Vite + React)
 
```bash
cd frontend
npm install
echo "VITE_API_URL=http://localhost:8000/api/v1" > .env.local
npm run dev                        # → http://localhost:5173
```
 
> No backend at hand? Set `VITE_USE_MOCKS=true` with an empty `VITE_API_URL` to explore the UI with generated mock data. Mock screens are clearly labelled **MOCK DATA**.
 
More detail: [`backend/README.md`](backend/README.md) · [`frontend/README.md`](frontend/README.md)
 
---
 
<div align="center">
<sub>Made with ☕ and moonlight for NASA Space Apps Challenge 2026.</sub>
</div>

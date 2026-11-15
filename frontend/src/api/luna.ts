import { ApiError, BASE, readError } from './http';
import { apiMode } from './client';

/** Luna — AI explanations. One topic = one prompt on the backend (POST /luna, NDJSON stream). */
export type LunaTopic = 'site-intro' | 'sim-score' | 'sim-worst' | 'sim-sun' | 'scen-why' | 'scen-decide';

export interface LunaRequest {
  topic: LunaTopic;
  siteId?: string;
  lat?: number;
  lon?: number;
  name?: string;
  terrain?: { elevationM?: number | null; slopeDeg?: number | null; psr?: boolean | null };
  simulationId?: string;
  scenarios?: { label: string; simulationId: string }[];
  requirements?: { minSocPct: number; minEarthVisiblePct: number };
  recommendation?: { label: string; reason?: string } | null;
  refresh?: boolean;
}

export interface LunaMeta {
  source: 'ai' | 'template' | 'mock';
  cached: boolean;
  /** Mission day the answer is about — the simulation timeline jumps there. */
  focusDay: number | null;
  model: string | null;
}

interface Handlers {
  signal?: AbortSignal;
  onMeta: (m: LunaMeta) => void;
  onDelta: (text: string) => void;
}

const LUNA_TIMEOUT_MS = 90_000;

export async function askLuna(req: LunaRequest, h: Handlers): Promise<void> {
  if (apiMode === 'mock') return mockLuna(req, h);
  if (apiMode === 'offline') throw new ApiError('OFFLINE', 'Luna needs the HORIZON backend (set VITE_API_URL).', 0);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LUNA_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  h.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(`${BASE}/luna`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: ac.signal,
      });
    } catch (e) {
      if (h.signal?.aborted) throw e;
      throw new ApiError('NETWORK', `Cannot reach the backend at ${BASE}. Is it running?`, 0);
    }
    if (!res.ok) throw await readError(res);
    if (!res.body) throw new ApiError('NO_STREAM', 'The backend sent an empty answer.', res.status);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'meta') h.onMeta({ source: msg.source, cached: !!msg.cached, focusDay: msg.focusDay ?? null, model: msg.model ?? null });
        else if (msg.type === 'delta') h.onDelta(msg.text);
        else if (msg.type === 'error') throw new ApiError('LUNA_STREAM', msg.message, 502);
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (h.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (ac.signal.aborted) throw new ApiError('CLIENT_TIMEOUT', 'Luna took too long to answer. Try again.', 0);
    throw e;
  } finally {
    clearTimeout(timer);
    h.signal?.removeEventListener('abort', onAbort);
  }
}

/* ---------- mock mode: canned answers so the panel can be designed and demoed offline ---------- */

const MOCK_TEXT: Record<LunaTopic, string> = {
  'site-intro':
    'This point sits in the **south polar region**, where the Sun never climbs more than a few degrees above the horizon.\n\nHigh ridges here can stay sunlit for long stretches while the crater floors around them stay dark for billions of years — cold enough to trap **water ice**.\n\nNext step: simulate a landing date to see how sunlight and Earth contact play out.',
  'sim-score':
    'This mission scores **72% (possible)**, held back mainly by the battery.\n- Battery: lowest charge 21% → 18 of 50 points; it barely clears the reserve.\n- Earth link: Earth in view 64% of the time → full 25 points.\n- Longest night: 61 h of darkness → full 25 points.\nA landing date whose long shadow falls after the mission ends would gain the most.',
  'sim-worst':
    'The critical moment comes on **mission day 9.6**: after 41 h in a ridge shadow the battery drops to **21%**.\n\nIt stays just above the 20% reserve, and Earth is in view, so the team can still talk to the lander. A slightly bigger battery would give a safer margin. The timeline now shows this moment.',
  'sim-sun':
    'The Sun is hidden by terrain for **58 h** while above the horizon, versus 22 h of true night.\n\nThe longest shadow comes from a ridge to the **west-southwest**, about 23 km away, rising 3.1° above the horizon while the Sun is only 1.8° high. Near the pole a low Sun means even a distant ridge casts a long shadow.',
  'scen-why':
    '**Slip +2 wk** wins with **84%** and meets both requirements.\n- Battery: its lowest charge is 38%, versus 18% for the baseline (2 points below the 20% requirement).\n- Earth in view: 61% versus 64% — almost the same.\nThe trade-off is a two-week launch slip.',
  'scen-decide':
    '**Slip the date** — a two-week slip fixes the battery problem without changing the site.\n- Best date slip: Slip +2 wk, 84%, meets requirements; costs 14 days.\n- Best site move: Shackleton rim, 76%, meets requirements; 12 km away with new terrain to certify.\nVerify that the new launch window fits the launch vehicle schedule.',
};

async function mockLuna(req: LunaRequest, h: Handlers) {
  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      h.signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('Aborted', 'AbortError'))), { once: true });
    });
  await wait(500);
  h.onMeta({ source: 'mock', cached: false, focusDay: req.topic === 'sim-worst' ? 9.6 : req.topic === 'sim-sun' ? 8.2 : null, model: null });
  const text = MOCK_TEXT[req.topic];
  for (let i = 0; i < text.length; i += 6) {
    await wait(18);
    h.onDelta(text.slice(i, i + 6));
  }
}

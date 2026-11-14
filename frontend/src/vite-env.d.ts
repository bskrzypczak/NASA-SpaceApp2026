/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL, e.g. http://localhost:8000/api/v1. Empty = no backend. */
  readonly VITE_API_URL?: string;
  /** "true" = use generated mock data when no backend is configured. */
  readonly VITE_USE_MOCKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

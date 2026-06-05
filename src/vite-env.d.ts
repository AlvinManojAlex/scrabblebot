/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STDB_HOST?: string;
  readonly VITE_STDB_DB?: string;
  readonly VITE_SPACETIMEAUTH_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TARGET_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

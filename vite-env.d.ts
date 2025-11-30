/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROFILE_PIN_SALT?: string;
  readonly TRAEKY_PROFILE_PIN_SALT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

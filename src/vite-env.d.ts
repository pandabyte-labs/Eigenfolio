/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROFILE_PIN_SALT?: string;
  readonly TRAEKY_PROFILE_PIN_SALT?: string;
  readonly VITE_PROFILE_ENCRYPTION_KEY?: string;
  readonly TRAEKY_PROFILE_ENCRYPTION_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

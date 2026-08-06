/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** E.164 inbound number for the hero placard; overrides the shipped trunk number. */
  readonly VITE_PHONE_NUMBER?: string;
  /** How that number is grouped for reading; defaults to the E.164 form. */
  readonly VITE_PHONE_DISPLAY?: string;
  readonly VITE_REPO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

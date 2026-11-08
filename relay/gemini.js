// Which Gemini models and voices the relay uses, in one place so they are easy to change.
import { GoogleGenAI } from '@google/genai';

export { LIVE_MODEL } from './token.js';
export const TEXT_MODEL = 'gemini-3.1-flash-lite';
export const TEXT_MODELS = [TEXT_MODEL, 'gemini-flash-lite-latest', 'gemini-flash-latest'];
// Voices that, with the accent rules in document.js, came out British in English and from Spain in Spanish when tested
// (Gemini's other voices drifted to American English or Latin American Spanish).
export const VOICES = ['Despina', 'Gacrux', 'Umbriel', 'Sadaltager'];
export const DEFAULT_VOICE = 'Despina';

// Gemini's Live API answers on v1alpha only (the v1beta Live address returns 404), and ephemeral passes need it too.
export const API_VERSION = 'v1alpha';

export function makeClient(apiKey) {
  return new GoogleGenAI({ apiKey, httpOptions: { apiVersion: API_VERSION } });
}

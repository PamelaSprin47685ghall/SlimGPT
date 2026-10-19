// MAIN-world entry, bundled to main-hook.js (classic IIFE script, no exports
// so nothing leaks onto the chatgpt.com global object).
import { installHook } from './runtime.js';

installHook(window);

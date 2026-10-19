// Thin adapter over the real DOM used by the composer driver. Keeping every
// DOM touch here lets the driver be tested against a plain-object fake.
// The adapter reads official *controls* (buttons, composer, menus) only; it
// never reads message content.

/**
 * @typedef {object} DomAdapter
 * @property {(selector: string) => Element[]} queryAll
 * @property {(root: Element, selector: string) => Element[]} queryWithin
 * @property {(element: Element, selector: string) => Element|null} closest
 * @property {(element: Element) => boolean} isVisible
 * @property {(element: Element) => boolean} isEnabledButton
 * @property {(element: Element) => string} label
 * @property {(element: Element, name: string) => string|null} attr
 * @property {() => boolean} rootInert
 * @property {<T>(probe: () => T, timeoutMs: number) => Promise<T|null>} waitFor
 * @property {(element: Element, text: string) => boolean} insertText
 * @property {(element: Element) => string} readValue
 * @property {(element: Element) => void} click
 * @property {(element: Element) => void} activate
 * @property {(element: Element, key: string) => void} pressKey
 * @property {(value: string) => string} escape
 */

/**
 * @param {Window & typeof globalThis} win
 * @returns {DomAdapter}
 */
export function createDomAdapter(win) {
  const doc = win.document;
  const safeAll = (root, selector) => {
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  };

  return {
    queryAll: (selector) => safeAll(doc, selector),
    queryWithin: (root, selector) => safeAll(root, selector),
    closest: (element, selector) => {
      try {
        return element.closest(selector);
      } catch {
        return null;
      }
    },
    isVisible(element) {
      if (!(element instanceof win.Element)) return false;
      const style = win.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    },
    isEnabledButton(element) {
      return element instanceof win.HTMLButtonElement &&
        !element.disabled &&
        !element.hidden &&
        element.getAttribute('aria-disabled') !== 'true' &&
        element.getAttribute('aria-hidden') !== 'true' &&
        !element.hasAttribute('data-visually-disabled');
    },
    label(element) {
      return [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    },
    attr: (element, name) => element.getAttribute(name),
    rootInert: () => Boolean(doc.documentElement?.inert || doc.body?.inert),
    waitFor(probe, timeoutMs) {
      return new Promise((resolve) => {
        let settled = false;
        let observer = null;
        let timer = null;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer !== null) win.clearTimeout(timer);
          observer?.disconnect();
          resolve(value);
        };
        const scan = () => {
          let value = null;
          try { value = probe(); } catch { value = null; }
          if (value) finish(value);
        };
        scan();
        if (settled) return;
        observer = new win.MutationObserver(scan);
        observer.observe(doc.documentElement || doc, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['disabled', 'aria-disabled', 'data-visually-disabled', 'aria-valuenow', 'value', 'aria-expanded', 'contenteditable', 'data-message-id'],
        });
        timer = win.setTimeout(() => finish(null), timeoutMs);
      });
    },
    insertText(element, text) {
      try {
        element.focus({ preventScroll: true });
      } catch { /* ignore */ }
      if (element instanceof win.HTMLTextAreaElement || element instanceof win.HTMLInputElement) {
        const proto = element instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (!setter) return false;
        setter.call(element, text);
        element.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        element.dispatchEvent(new win.Event('change', { bubbles: true }));
        return true;
      }
      const selection = win.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      // execCommand keeps ProseMirror's own input pipeline in charge.
      if (doc.execCommand('insertText', false, text)) return true;
      element.textContent = text;
      element.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    },
    readValue(element) {
      if (element instanceof win.HTMLTextAreaElement || element instanceof win.HTMLInputElement) return element.value;
      return String(element.textContent || '');
    },
    click: (element) => /** @type {HTMLElement} */ (element).click(),
    activate(element) {
      const rect = element.getBoundingClientRect();
      const init = {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
      };
      element.dispatchEvent(new win.PointerEvent('pointerdown', init));
      element.dispatchEvent(new win.MouseEvent('mousedown', init));
      element.dispatchEvent(new win.PointerEvent('pointerup', { ...init, buttons: 0 }));
      element.dispatchEvent(new win.MouseEvent('mouseup', { ...init, buttons: 0 }));
      element.dispatchEvent(new win.MouseEvent('click', { ...init, buttons: 0, detail: 1 }));
    },
    pressKey(element, key) {
      try { /** @type {HTMLElement} */ (element).focus({ preventScroll: true }); } catch { /* ignore */ }
      element.dispatchEvent(new win.KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
      element.dispatchEvent(new win.KeyboardEvent('keyup', { key, code: key, bubbles: true }));
    },
    escape: (value) => (win.CSS?.escape ? win.CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&')),
  };
}

/* global document, customElements, window, URLSearchParams, fetch, history, setTimeout  */

// NonTokenValues.js
import { LitElement, html } from 'lit';
import './AcornLoader.js';

/** URL param used by details-state-url.js for open details */
const OPEN_PARAM = 'o';

/**
 * BaseElement extends LitElement to provide shared rendering behavior.
 *
 * It overrides the standard `createRenderRoot()` method to clone and attach
 * all global `<link rel="stylesheet">` elements from the document head into
 * the component's shadow root. This ensures that global stylesheets are
 * available inside the shadow DOM for consistent styling.
 */
export class BaseElement extends LitElement {
  /**
   * Creates and returns the shadow root for this element.
   *
   * This implementation copies all `<link rel="stylesheet">` elements
   * from the document head into the new shadow root, allowing global
   * styles to apply within the shadow DOM context.
   *
   * @returns {ShadowRoot} The initialized shadow root containing cloned stylesheet links.
   */
  createRenderRoot() {
    let root = this.attachShadow({ mode: 'open' });
    const links = document.head.getElementsByTagName('link');
    for (let i = 0; i < links.length; i++) {
      const link = links.item(i);
      if (!link || link.rel !== 'stylesheet') {
        continue;
      }
      root.appendChild(link.cloneNode(true));
    }
    return root;
  }
}

/**
 * Validate a user-supplied pattern string that may end with a single wildcard "*".
 *
 * Additional hardening:
 * - Only the following characters are allowed (before any trailing "*"):
 *   letters, digits, spaces, ".", ",", "_", "%", "#", "(", ")", "/", "+", "-".
 *   This excludes quotes, angle brackets, equals, pipes, etc.
 * - Maximum length enforced to reduce pathological inputs.
 *
 * Examples of valid inputs:
 *   "red", "0 auto", "#fff", "calc(", "rgba(", "var(", "shadow-", "abc*", "0 auto*"
 *
 * @param {string} pattern The pattern string to validate.
 * @returns {{ ok: boolean, message?: string }}
 */
function validatePattern(pattern) {
  const MAX_LEN = 64;
  const p = String(pattern || '').trim();

  if (p.length === 0) {
    return { ok: false, message: 'Pattern cannot be empty.' };
  }

  if (p.length > MAX_LEN) {
    return {
      ok: false,
      message: `Pattern is too long, max ${MAX_LEN} characters.`,
    };
  }

  if (p === '*') {
    return { ok: true };
  }

  // Reject multiple wildcards anywhere
  const asteriskCount = (p.match(/\*/g) || []).length;
  if (asteriskCount > 1) {
    return { ok: false, message: 'Only one wildcard "*" is allowed.' };
  }

  // If there is a wildcard it must be the last character
  const hasWildcard = asteriskCount === 1;
  if (hasWildcard && !p.endsWith('*')) {
    return { ok: false, message: 'Wildcard "*" is only supported at the end.' };
  }

  // Base part to validate against allowed characters
  const base = hasWildcard ? p.slice(0, -1) : p;

  // Must have a non-empty prefix when using "*"
  if (hasWildcard && base.length === 0) {
    return {
      ok: false,
      message: 'Prefix is required before the wildcard "*".',
    };
  }

  // Allowed characters for the non-wildcard portion.
  // Letters, digits, space, dot, comma, underscore, percent, hash, parentheses,
  // forward slash, plus, minus.
  // Intentionally excludes quotes, angle brackets, equals, backticks, semicolons, pipes, ampersands.
  const ALLOWED_BASE_RE = /^[a-z0-9\s.,_%#()/+-]*$/i;

  if (!ALLOWED_BASE_RE.test(base)) {
    return {
      ok: false,
      message: 'Pattern contains disallowed characters.',
    };
  }

  return { ok: true };
}

/**
 * Check whether a given descriptor string matches a pattern that may include a trailing wildcard (`*`).
 *
 * Matching behavior:
 * - A pattern of `"*"` matches all descriptors.
 * - If the pattern contains no wildcard, it must match the descriptor exactly.
 * - If the pattern ends with `"*"`, the descriptor must start with the pattern's prefix before the wildcard.
 *
 * @param {string} descriptor - The descriptor name to test (e.g., `"border-color"`).
 * @param {string} pattern - The pattern to match against, which may include a trailing `"*"` wildcard.
 * @returns {boolean} `true` if the descriptor matches the pattern, otherwise `false`.
 */
function matchesDescriptorPattern(descriptor, pattern) {
  if (pattern === '*') {
    return true;
  }
  if (!pattern.includes('*')) {
    return descriptor === pattern;
  }
  const prefix = pattern.slice(0, -1);
  return descriptor.startsWith(prefix);
}

/**
 * Renders a filterable list of non-token descriptor values from `descriptorValues.json`,
 * with controls synced to the URL query string. Provides a pattern filter, an option
 * to exclude ignored values, and per-file usage breakdowns. Shows a loader while
 * fetching, and a clear error message on failure.
 *
 * URL parameters:
 * - `pattern`: descriptor filter, `*` or suffix wildcard allowed, defaults to `*`
 * - `ex`: exclude ignored values flag, `"1"` enables
 * - `o`: comma separated list of open <details> ids
 *
 * Lit reactive properties:
 * @property {string} pattern Current descriptor filter. Reflected to the URL.
 * @property {string[]} openDetails Keys of <details> elements that are open. Reflected.
 * @property {boolean} excludeIgnored When true, ignored values are excluded. Reflected as `exclude-ignored`.
 *
 * @private
 * @property {boolean} _loading Whether data is being fetched.
 * @property {object|null} _data Loaded dataset, or null on error.
 * @property {string|null} _error Error message to display, or null.
 *
 * Fetches `../data/descriptorValues.json`. Non-2xx responses raise an error so the
 * UI can present feedback and avoid rendering stale data.
 *
 * Behaviour summary:
 * - Reads initial control state from the URL in the constructor.
 * - Subscribes to `popstate` in `connectedCallback`, re-syncs controls on navigation, and loads data.
 * - Persists control changes back to the URL, resets open detail state when filter flags change.
 * - Filters out token values, and optionally ignored ones, then sorts results by count.
 *
 * @augments BaseElement
 */
export class NonTokenValuesElement extends BaseElement {
  static properties = {
    pattern: { type: String },
    openDetails: {
      type: Array,
      reflect: true,
    },
    excludeIgnored: {
      type: Boolean,
      attribute: 'exclude-ignored',
      reflect: true,
    },
    _loading: { state: true },
    _data: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    const { pattern, excludeIgnored, openDetails } =
      this._readControlsFromURL();
    this.pattern = pattern;
    this.excludeIgnored = excludeIgnored;
    this.openDetails = openDetails;
    this._data = null;
    this._error = '';
    this._loading = true;
    this._onPopState = () => {
      const next = this._readControlsFromURL();
      this.pattern = next.pattern;
      this.openDetails = next.openDetails;
      this.excludeIgnored = next.excludeIgnored;
    };
  }

  /**
   * Lifecycle callback when the element is inserted into the DOM.
   * Subscribes to `popstate` to re-sync control state when the user navigates.
   *
   * @override
   * @returns {void}
   */
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('popstate', this._onPopState);
    this.#load();
  }

  /**
   * Lifecycle callback when the element is removed from the DOM.
   * Unsubscribes from `popstate`.
   *
   * @override
   * @returns {void}
   */
  disconnectedCallback() {
    window.removeEventListener('popstate', this._onPopState);
    super.disconnectedCallback();
  }

  /**
   * Fetch data and update reactive state with loading and error handling.
   *
   * Sets `_loading` while fetching, ensures the operation lasts at least
   * `minDurationMs` milliseconds, and stores the result or error message.
   * Always resets `_loading` when complete.
   *
   * @private
   * @returns {Promise<void>} Resolves when loading and state updates complete.
   */
  async #load() {
    this._loading = true;
    this._error = null;
    try {
      const data = await this.#minDuration(
        this.#fetchData(),
        this.minDurationMs ?? 850,
      );
      this._data = data;
    } catch (err) {
      this._data = null;
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._loading = false;
    }
  }

  /**
   * Fetch descriptor data from `../data/descriptorValues.json`.
   *
   * Throws an error on non-2xx responses or unexpected fetch results.
   * Accepts mock objects in tests when the response includes `ok: true`.
   *
   * @private
   * @returns {Promise<object>} Parsed JSON data or a compatible stub object.
   * @throws {Error} If the fetch fails or returns an unexpected format.
   */
  async #fetchData() {
    const res = await fetch('../data/descriptorValues.json');

    // Throw on non-2xx so #load() can set _error and null _data
    if (!res || (typeof res.ok === 'boolean' && !res.ok)) {
      const status = typeof res?.status === 'number' ? res.status : 'unknown';
      throw new Error(
        `Failed to fetch descriptorValues.json, status ${status}`,
      );
    }

    if (typeof res.json === 'function') {
      return res.json();
    }

    // Allow plain-object stubs in tests, but only if we got "ok"
    if (res && typeof res === 'object') {
      return res;
    }

    throw new TypeError('Unexpected fetch() response in #fetchData');
  }

  /**
   * Await a promise but ensure it takes at least the given duration.
   *
   * Useful for keeping loading indicators visible for a minimum time
   * to avoid flicker during very fast responses.
   *
   * @private
   * @param {Promise<any>} promise The promise to await.
   * @param {number} minMs Minimum duration in milliseconds.
   * @returns {Promise<any>} Resolves with the result of `promise` after at least `minMs` elapsed.
   */
  async #minDuration(promise, minMs) {
    const [result] = await Promise.all([
      promise,
      new Promise((r) => setTimeout(r, minMs)),
    ]);
    return result;
  }

  /**
   * Read current control state from the URL query string.
   *
   * Recognized parameters:
   * - `pattern`: descriptor filter, may be `*` or suffix wildcard, defaults to `*`.
   * - `ex`: exclude ignored values flag, `"1"` to enable.
   * - `o`: comma separated list of open detail ids.
   *
   * @private
   * @returns {{ pattern: string, excludeIgnored: boolean, openDetails: string[] }}
   */
  _readControlsFromURL() {
    const params = new URLSearchParams(window.location.search);
    let pattern = params.get('pattern') || '*';
    // Let's default the param if what was received was not valid.
    if (validatePattern(pattern).ok === false) {
      pattern = '*';
    }
    const openDetails = params.get(OPEN_PARAM)?.split(',') || [];
    const excludeIgnored = params.get('ex') === '1';
    return { pattern, excludeIgnored, openDetails };
  }

  /**
   * Persist the current control state to the URL.
   * Resets `this.openDetails` to an empty array to avoid stale ids when the
   * filter pattern or exclude flag changes.
   *
   * @private
   * @param {{ replace?: boolean }} [opts] - When `true`, use `history.replaceState`
   * instead of `pushState`.
   * @returns {void}
   */
  _writeStateToURL({ replace = false } = {}) {
    const params = new URLSearchParams(window.location.search);

    const currentPattern = params.get('pattern');
    const currentExcludeIgnored = params.get('ex');
    if (
      currentPattern != this.pattern ||
      currentExcludeIgnored != this.excludeIgnored
    ) {
      params.set('pattern', this.pattern);
      params.set('ex', this.excludeIgnored ? '1' : '0');
      params.delete(OPEN_PARAM);
      this.openDetails = [];
    } else {
      if (this.openDetails.length) {
        params.set(OPEN_PARAM, this.openDetails.join(','));
      } else {
        params.delete(OPEN_PARAM);
      }
    }
    const url = `${window.location.pathname}?${params.toString()}`;
    if (replace) {
      history.replaceState({}, '', url);
    } else {
      history.pushState({}, '', url);
    }
  }

  /**
   * Track an individual <details> element's open state.
   *
   * @param {Event} e - The `toggle` event dispatched by a <details> element.
   * @returns {void}
   */
  _onToggleDetails(e) {
    const newKey = e.target.getAttribute('data-details-key');
    const openSet = new Set(this.openDetails);
    if (e.target.open) {
      openSet.add(newKey);
    } else {
      openSet.delete(newKey);
    }
    const updatedOpenDetails = Array.from(openSet);
    this.openDetails = updatedOpenDetails;
    this._writeStateToURL();
  }

  /**
   * Handle user input for the descriptor pattern field.
   * Trims whitespace and, when the pattern is valid, writes state to the URL.
   *
   * @private
   * @param {InputEvent} e - The input event from the pattern field.
   * @returns {void}
   */
  _onPatternInput(e) {
    this.pattern = e.currentTarget.value.trim();
    const { ok } = validatePattern(this.pattern);
    if (ok) {
      this._writeStateToURL();
    }
  }

  /**
   * Handle changes to the "exclude ignored values" checkbox.
   * Updates local state and persists the change to the URL.
   *
   * @private
   * @param {Event} e - The change event from the checkbox.
   * @returns {void}
   */
  _onExcludeToggle(e) {
    this.excludeIgnored = e.currentTarget.checked;
    this._writeStateToURL();
  }

  /**
   * Return a sorted list of known descriptor names from the loaded dataset.
   *
   * @private
   * @returns {string[]} Alphabetically sorted descriptor names, empty if data is missing.
   */
  _descriptorNames() {
    if (!this._data?.byDescriptor) {
      return [];
    }
    return Object.keys(this._data.byDescriptor).sort((a, b) => {
      return a.localeCompare(b);
    });
  }

  /**
   * Build and return a flattened list of non-token descriptor/value usage records
   * filtered by the current pattern and configuration flags.
   *
   * The returned array contains one entry per unique descriptor/value pair
   * (excluding design token values and optionally ignored ones),
   * each including its usage count and per-file breakdown.
   *
   * Filtering behavior:
   * - Skips if `this._data.byDescriptor` is missing.
   * - Skips entirely if the current `this.pattern` is invalid per `validatePattern()`.
   * - Includes only descriptors matching `this.pattern` via `matchesDescriptorPattern()`.
   * - Excludes entries where `valObj.containsToken === true`.
   * - Excludes ignored entries if `this.excludeIgnored` is true.
   *
   * @private
   * @returns {Array<{
   *   descriptor: string,
   *   value: string,
   *   count: number,
   *   files: Array<{ path: string, count: number }>,
   *   id: string
   * }>} Array of descriptor/value records suitable for table rendering or aggregation.
   */
  _rows() {
    const data = this._data;
    if (!data?.byDescriptor) {
      return [];
    }
    const valid = validatePattern(this.pattern);
    if (!valid.ok) {
      return [];
    }

    /** @type {Array<{ descriptor: string, value: string, count: number, files: Array<{ path: string, count: number }>, id: string }>} */
    const rows = [];
    for (const [descriptor, descObj] of Object.entries(data.byDescriptor)) {
      if (!matchesDescriptorPattern(descriptor, this.pattern)) {
        continue;
      }
      const values = descObj?.values || {};
      for (const [value, valObj] of Object.entries(values)) {
        if (!valObj || typeof valObj.count !== 'number') {
          continue;
        }
        if (valObj.containsToken === true) {
          continue;
        }
        // non-token values only
        if (this.excludeIgnored && valObj.isIgnored === true) {
          continue;
        }
        const filesArray = [];
        const filesObj = valObj.files || {};
        for (const [path, cnt] of Object.entries(filesObj)) {
          filesArray.push({ path, count: Number(cnt) || 0 });
        }
        rows.push({
          descriptor,
          value,
          count: valObj.count,
          files: filesArray,
          id: String(valObj.id ?? ''),
        });
      }
    }

    rows.sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      const ka = `${a.descriptor}:${a.value}`;
      const kb = `${b.descriptor}:${b.value}`;
      return ka.localeCompare(kb);
    });
    return rows;
  }

  /**
   * Render the controls and the non-token value list.
   * Shows validation feedback for the pattern, a toggle to exclude ignored values,
   * and a grouped list of descriptor values with per-file counts.
   *
   * @returns {import('lit').TemplateResult}
   */
  render() {
    if (this._error) {
      return html`<p id="load-error" class="notice error" role="alert">
        ${this._error}
      </p>`;
    }

    const check = validatePattern(this.pattern);
    const rows = check.ok ? this._rows() : [];

    return html` <acorn-loader .active=${this._loading}></acorn-loader>

      ${!this._loading
        ? html` <form
              id="descriptor-controls"
              class="controls"
              @submit=${(e) => {
                e.preventDefault();
              }}
              @keydown=${(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                }
              }}
            >
              <div class="control">
                <label for="pattern">Descriptor Pattern</label>
                <input
                  id="pattern"
                  .value=${this.pattern}
                  @input=${(e) => {
                    this._onPatternInput(e);
                  }}
                  list="descriptor-suggestions"
                  autocomplete="off"
                />
                <datalist id="descriptor-suggestions">
                  ${this._descriptorNames().map((name) => {
                    return html`<option value=${name}></option>`;
                  })}
                </datalist>
                <p id="pattern-help" class="form-help">
                  Use exact names like <code>margin-inline-start</code> or a
                  suffix wildcard like <code>margin-*</code>. A single
                  <code>*</code> matches all.
                </p>

                ${!check.ok
                  ? html`<p
                      id="pattern-error"
                      class="notice error"
                      role="alert"
                    >
                      ${check.message}
                    </p>`
                  : null}
              </div>

              <div class="control">
                <label for="excludeIgnored">
                  <input
                    id="excludeIgnored"
                    type="checkbox"
                    .checked=${this.excludeIgnored}
                    @change=${(e) => {
                      this._onExcludeToggle(e);
                    }}
                  />
                  Exclude ignored
                </label>
              </div>
            </form>

            ${check.ok
              ? html` <section id="non-token-section" class="descriptors">
                  <h3 id="non-token-heading" ?hidden=${rows.length === 0}>
                    Most common non-token values for:
                    <code>${this.pattern}</code>
                  </h3>
                  ${rows.length === 0
                    ? html`
                        <p
                          id="no-results"
                          class="notice error"
                          role="status"
                          aria-live="polite"
                        >
                          No non-token values matched the pattern
                          "${this.pattern}"${this.excludeIgnored
                            ? ', ignoring excluded values'
                            : ''}.
                        </p>
                      `
                    : html`
                        <ol class="non-token-list">
                          ${rows.map((row) => {
                            return html`
                              <li class="non-token-item">
                                <details
                                  data-details-key="d${row.id}"
                                  ?open=${this.openDetails.includes(
                                    `d${row.id}`,
                                  )}
                                  @toggle=${this._onToggleDetails}
                                >
                                  <summary>
                                    <code>${row.descriptor}: ${row.value}</code>
                                    <span class="count">[${row.count}]</span>
                                  </summary>
                                  <ul>
                                    ${row.files.map((f) => {
                                      return html`
                                        <li>
                                          <a href="../${f.path}">/${f.path}</a>
                                          <span class="count"
                                            >[${f.count}]</span
                                          >
                                        </li>
                                      `;
                                    })}
                                  </ul>
                                </details>
                              </li>
                            `;
                          })}
                        </ol>
                      `}
                </section>`
              : null}`
        : null}`;
  }
}

customElements.define('non-token-values', NonTokenValuesElement);

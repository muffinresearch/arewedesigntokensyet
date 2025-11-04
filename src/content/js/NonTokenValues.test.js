// @vitest-environment jsdom
/* global history, document, window, URLSearchParams */

import { NonTokenValuesElement } from './NonTokenValues.js';

// Only update path/query to avoid jsdom SecurityError from changing origin.
function setURLPath(pathAndQuery = '/') {
  if (!pathAndQuery.startsWith('/')) {
    throw new Error('setURLPath requires a path that starts with "/"');
  }
  history.replaceState({}, '', pathAndQuery);
}

function makeElementAt(pathAndQuery) {
  setURLPath(pathAndQuery);
  const el = new NonTokenValuesElement();
  el.minDurationMs = 0;
  return el;
}

function sampleData() {
  return {
    byDescriptor: {
      margin: {
        values: {
          0: {
            count: 3,
            containsToken: false,
            isIgnored: true,
            files: { 'a.css': 2, 'b.css': 1 },
            id: 'm0',
          },
          '0 auto': {
            count: 2,
            containsToken: false,
            isIgnored: false,
            files: { 'a.css': 1, 'c.css': 1 },
            id: 'm1',
          },
          'var(--token-x)': {
            count: 5,
            containsToken: true,
            isIgnored: false,
            files: { 't.css': 5 },
            id: 'mt',
          },
        },
      },
      padding: {
        values: {
          '4px': {
            count: 10,
            containsToken: false,
            isIgnored: false,
            files: { 'p.css': 10 },
            id: 'p4',
          },
          '2px': {
            count: 10,
            containsToken: false,
            isIgnored: false,
            files: { 'p2.css': 10 },
            id: 'p2',
          },
        },
      },
    },
  };
}

describe('NonTokenValuesElement URL state helpers', () => {
  beforeEach(() => {
    setURLPath('/stats/descriptors/?pattern=*&ex=0');
    vi.restoreAllMocks();
  });

  test('_readControlsFromURL returns expected defaults and parsed state', () => {
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=1&o=a,b,c');
    const state = el._readControlsFromURL();

    expect(state.pattern).toBe('*');
    expect(state.excludeIgnored).toBe(true);
    expect(state.openDetails).toEqual(['a', 'b', 'c']);
  });

  test('_writeStateToURL clears open set when pattern or exclude changes', () => {
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=0&o=foo,bar');
    el.pattern = 'mar*';
    el.excludeIgnored = true;
    el.openDetails = ['x', 'y'];

    const replaceSpy = vi.spyOn(history, 'replaceState');
    el._writeStateToURL({ replace: true });

    expect(el.openDetails).toEqual([]);
    expect(window.location.pathname).toBe('/stats/descriptors/');
    expect(window.location.search).toContain('pattern=mar*');
    expect(window.location.search).toContain('ex=1');
    expect(window.location.search).not.toContain('o=');
    expect(replaceSpy).toHaveBeenCalled();
  });

  test('_writeStateToURL preserves open set when unchanged', () => {
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=0');
    el.pattern = '*';
    el.excludeIgnored = false;
    el.openDetails = ['a', 'b', 'c'];

    const pushSpy = vi.spyOn(history, 'pushState');
    el._writeStateToURL({ replace: false });

    expect(window.location.pathname).toBe('/stats/descriptors/');
    expect(window.location.search).toContain('pattern=*');
    expect(window.location.search).toContain('ex=0');
    expect(window.location.search).toContain('o=a%2Cb%2Cc');
    expect(pushSpy).toHaveBeenCalled();
  });

  test('_onToggleDetails adds and removes keys from openDetails', () => {
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=0');
    el.pattern = '*';
    el.excludeIgnored = false;
    el.openDetails = [];

    const writeSpy = vi.spyOn(el, '_writeStateToURL');

    const details = document.createElement('details');
    details.setAttribute('data-details-key', 'row-1');

    details.open = true;
    el._onToggleDetails({ target: details });
    expect(el.openDetails).toEqual(['row-1']);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    details.open = false;
    el._onToggleDetails({ target: details });
    expect(el.openDetails).toEqual([]);
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });
});

describe('NonTokenValuesElement data helpers', () => {
  test('_descriptorNames returns sorted descriptor keys', () => {
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=0');
    el._data = sampleData();
    expect(el._descriptorNames()).toEqual(['margin', 'padding']);
  });

  test('_rows returns empty when no data or invalid pattern', () => {
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=0');
    el.pattern = '*';
    el.excludeIgnored = false;
    el._data = null;
    expect(el._rows()).toEqual([]);

    el._data = sampleData();
    el.pattern = 'ma*r*gin';
    expect(el._rows()).toEqual([]);
  });

  test('_rows includes only non-token values and respects excludeIgnored=false', () => {
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=0');
    el._data = sampleData();
    el.pattern = '*';
    el.excludeIgnored = false;

    const rows = el._rows();
    const key = (r) => `${r.descriptor}:${r.value}`;
    const keys = rows.map(key);

    expect(keys).not.toContain('margin:var(--token-x)');
    expect(keys).toContain('margin:0');
    expect(keys).toContain('padding:4px');
  });

  test('_rows filters by suffix wildcard and excludes ignored when requested', () => {
    const el = makeElementAt('/stats/descriptors/?pattern=mar*&ex=0');
    el._data = sampleData();
    el.pattern = 'mar*';
    el.excludeIgnored = true;

    const rows = el._rows();
    const set = new Set(rows.map((r) => r.descriptor));

    expect(set).toEqual(new Set(['margin']));
    expect(rows.find((r) => r.value === '0')).toBeUndefined();
    expect(rows.find((r) => r.value === '0 auto')).toBeDefined();
  });

  test('_rows sorts by count desc, then descriptor:value lexicographically', () => {
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=0');
    el._data = sampleData();
    el.pattern = '*';
    el.excludeIgnored = false;

    const rows = el._rows();

    expect(rows[0].descriptor).toBe('padding');
    expect(rows[0].count).toBe(10);
    expect(rows[1].descriptor).toBe('padding');
    expect(rows[1].count).toBe(10);

    const topTwoValues = [rows[0].value, rows[1].value].sort((a, b) => {
      return a.localeCompare(b);
    });
    expect(topTwoValues).toEqual(['2px', '4px']);

    expect(rows[2].descriptor).toBe('margin');
    expect(rows[2].count).toBe(3);
    expect(rows[3].descriptor).toBe('margin');
    expect(rows[3].count).toBe(2);
  });
});

describe('NonTokenValuesElement data loading', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setURLPath('/stats/descriptors/?pattern=*&ex=0');
  });

  test('connectedCallback fetches descriptorValues and sets _data on success', async () => {
    const payload = sampleData();

    // Mock a proper Response-like value so res.json() exists
    const fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
    });

    // Use fake timers to skip the 850 ms delay in #minDuration
    vi.useFakeTimers();

    const el = new NonTokenValuesElement();
    el.connectedCallback();

    // Run all timers so #minDuration resolves
    await vi.runAllTimersAsync();

    // Wait for Lit updates
    await el.updateComplete;

    expect(fetchSpy).toHaveBeenCalledWith('../data/descriptorValues.json');
    expect(el._data).toEqual(payload);
    expect(el._error).toBeFalsy();

    vi.useRealTimers();
  });

  test('connectedCallback sets _error when fetch fails', async () => {
    // Return a Response-like object that isn't ok
    const fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      async json() {
        return {};
      },
    });

    vi.useFakeTimers();

    const el = new NonTokenValuesElement();
    el.connectedCallback();

    await vi.runAllTimersAsync();
    await el.updateComplete;

    expect(fetchSpy).toHaveBeenCalledWith('../data/descriptorValues.json');
    expect(el._data).toBeNull();
    expect(typeof el._error).toBe('string');

    vi.useRealTimers();
  });
});

describe('check handling of malformed user content', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('URL writing: pattern is safely encoded in query string', () => {
    // Malicious-looking pattern with angle brackets and event handler.
    const bad = '<img src=x onerror=alert(1)>';
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=0');

    el.pattern = bad;
    el.excludeIgnored = false;
    el.openDetails = ['safe'];
    el._writeStateToURL({ replace: true });

    // Should not see raw dangerous characters in the query string.
    expect(window.location.search).not.toMatch(/[<>"']/);
    // Roundtrip decode should match the original pattern.
    const params = new URLSearchParams(window.location.search);
    expect(params.get('pattern')).toBe(bad);
    // And ex flag still present.
    expect(params.get('ex')).toBe('0');
  });

  test('Rendering: hostile values are text, not HTML', async () => {
    // Local fetch mock with hostile content
    const payload = {
      byDescriptor: {
        color: {
          values: {
            '<script>alert(1)</script>': {
              count: 1,
              containsToken: false,
              isIgnored: false,
              files: { 'a.css': 1 },
              id: 'h1',
            },
            '<img src=x onerror=alert(2)>': {
              count: 1,
              containsToken: false,
              isIgnored: false,
              files: { 'b.css': 1 },
              id: 'h2',
            },
          },
        },
      },
    };

    const fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
    });

    // Ensure all rows match
    setURLPath('/stats/descriptors/?p=*&ex=0');

    // Avoid waiting 850 ms in real time
    vi.useFakeTimers();

    const el = new NonTokenValuesElement();
    document.body.appendChild(el);
    el.connectedCallback?.();

    await vi.runAllTimersAsync();
    if ('updateComplete' in el) {
      await el.updateComplete;
    }

    // Assert against the whole shadow DOM.
    const shadowHTML = el.shadowRoot.innerHTML;

    // No raw HTML injection
    expect(shadowHTML).not.toContain('<script');
    expect(shadowHTML).not.toContain('<img ');

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  test('Rendering: hostile openDetails entries cannot inject DOM', async () => {
    const el = makeElementAt('/stats/descriptors/?pattern=*&ex=0');
    el._data = sampleData();
    el.pattern = '*';
    el.excludeIgnored = false;

    // Pretend URL or code produced a hostile key.
    const hostileKey = '<svg onload=alert(1)>';
    el.openDetails = [hostileKey];

    document.body.appendChild(el);
    await el.updateComplete;

    const html = el.shadowRoot.innerHTML;

    // No svg tag created, and the hostile value is not echoed at all
    // (neither raw nor escaped), because openDetails is used only for matching keys.
    expect(el.shadowRoot.querySelector('svg')).toBeNull();
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('&lt;svg');

    const anyOpen = Array.from(
      el.shadowRoot.querySelectorAll('details') ?? [],
    ).some((d) => d.open);
    expect(anyOpen).toBe(false);
  });
});

describe('stats components: safe links and attributes', () => {
  test('generated <a href> never uses javascript: and is path-based', async () => {
    // Local payload that guarantees at least one link
    const payload = {
      byDescriptor: {
        margin: {
          values: {
            0: {
              count: 2,
              containsToken: false,
              isIgnored: false,
              files: {
                'browser/a.css': 1,
                'javascript:alert(1)': 1,
              },
              id: '42',
            },
          },
        },
      },
    };

    const fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
    });

    // Ensure pattern matches and ignored values are included
    setURLPath('/stats/descriptors/?pattern=*&ex=0');

    vi.useFakeTimers();

    const el = new NonTokenValuesElement();
    document.body.appendChild(el);
    el.connectedCallback?.();

    await vi.runAllTimersAsync();
    if ('updateComplete' in el) {
      await el.updateComplete;
    }

    const links = Array.from(el.shadowRoot.querySelectorAll('a') ?? []);
    expect(links.length).toBeGreaterThan(0);

    for (const a of links) {
      const href = a.getAttribute('href') || '';
      // Must be relative to work with a base directory.
      expect(href.startsWith('../')).toBe(true);
      expect(href.toLowerCase().startsWith('javascript:')).toBe(false);
    }

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  test('data-attributes are not broken by hostile ids', async () => {
    // Hostile-ish id to exercise attribute escaping; component prefixes with "d"
    const payload = {
      byDescriptor: {
        color: {
          values: {
            '#fff': {
              count: 1,
              containsToken: false,
              isIgnored: false,
              files: { 'browser/colors.css': 1 },
              id: 'x" onmouseover="alert(1)', // intentionally nasty
            },
          },
        },
      },
    };

    const fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
    });

    setURLPath('/stats/descriptors/?pattern=*&ex=0');

    vi.useFakeTimers();

    const el = new NonTokenValuesElement();
    document.body.appendChild(el);
    el.connectedCallback?.();

    await vi.runAllTimersAsync();
    if ('updateComplete' in el) {
      await el.updateComplete;
    }

    const details = el.shadowRoot.querySelector('details[data-details-key]');
    expect(details).toBeTruthy();

    // data-details-key should contain the prefixed id as a single attribute value,
    // not break into new attributes.
    const keyVal = details?.getAttribute('data-details-key') ?? '';
    expect(keyVal).toContain('d'); // prefixed
    expect(keyVal).toContain('x" onmouseover="alert(1)'); // value preserved

    // Ensure outerHTML does not gain new attributes like onmouseover or stray x=
    const attrNames = Array.from(details?.attributes ?? []).map((a) => a.name);
    expect(attrNames).toContain('data-details-key');
    expect(attrNames).not.toContain('onmouseover');
    expect(attrNames).not.toContain('x');

    // Serialized HTML should show escaped quotes inside the attribute, not handlers
    const outer = details?.outerHTML ?? '';
    expect(outer).toContain('&quot; onmouseover=&quot;'); // quotes escaped
    expect(outer).not.toContain('<script');

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });
});

import fs from 'node:fs/promises';
import config from '../../config.js';
import { codeToHtml } from 'shiki';

/**
 * Determines whether a CSS variable name matches any known design token prefix.
 *
 * @param {string} name - The name of the variable (e.g. "--color-text").
 * @returns {boolean} - true if the name contains a design token key.
 */
function isDesignToken(name) {
  return config.designTokenKeys.some((token) => name.includes(token));
}

/**
 * Removes consecutive duplicate values from a resolution trace.
 *
 * @param {string[]} trace - The resolution trace to deduplicate.
 * @returns {string[]} - A new array with consecutive duplicates removed.
 */
function dedupeTrace(trace = []) {
  const result = [];
  for (let i = 0; i < trace.length; i++) {
    if (i === 0 || trace[i] !== trace[i - 1]) {
      result.push(trace[i]);
    }
  }
  return result;
}

/**
 * Returns a string representing the design token resolution status.
 *
 * @param {object} prop - A resolved property with token metadata.
 * @param {boolean} prop.containsDesignToken - Whether the value includes a known token.
 * @param {boolean} prop.isExcluded whether this property/value combination is excluded.
 * @returns {'good' | 'warn' | 'bad'} - The resolution status.
 */
function getStatus(prop) {
  let status = prop.containsDesignToken
    ? 'good'
    : prop.isExcluded
      ? 'warn'
      : 'bad';
  if (status === 'warn' && prop.isExcludedByStylelint) {
    status = 'excludedByStylelint';
  }
  return status;
}

/**
 * Constructs tooltip metadata for a given resolved property.
 *
 * Extracts trace, tokens used, resolution sources, and unresolved variables.
 *
 * @param {object} prop - A resolved property with metadata from analysis.
 * @returns {{
 *   status: string,
 *   trace: string[],
 *   tokens: string[],
 *   source: string[],
 *   unresolved: string[]
 * }}
 */
function extractTooltipData(prop) {
  const status = getStatus(prop);
  const trace = dedupeTrace(prop.resolutionTrace || []);

  const unresolved = (prop.unresolvedVariables || []).filter(
    (v) => !isDesignToken(v),
  );

  const tokensUsed = new Set();
  for (const step of trace) {
    const matches = step.match(/--[\w-]+/g) || [];
    for (const token of matches) {
      if (isDesignToken(token)) {
        tokensUsed.add(token);
      }
    }
  }

  return {
    status,
    trace,
    tokens: [...tokensUsed],
    source: !prop.isExcluded ? prop.resolutionSources || [] : [],
    unresolved,
  };
}

/**
 * Reads a CSS file, decorates it with Shiki, and embeds design token metadata as tooltip data.
 *
 * Adds data attributes to Shiki decorations for tooltip display, including resolution trace,
 * token usage, unresolved variables, and resolution status.
 *
 * @param {string} filePath - Absolute path to the CSS file.
 * @param {Array<object>} foundPropValues - An array of resolved CSS properties to annotate.
 * @returns {Promise<string>} - HTML string with Shiki syntax highlighting and tooltip metadata.
 */
export default async function loadAndAnnotateFile(filePath, foundPropValues) {
  const content = await fs.readFile(filePath, 'utf8');
  const decorations = [];

  for (const prop of foundPropValues) {
    const { start, end, resolutionType } = prop;

    const tooltipData = extractTooltipData(prop);

    decorations.push({
      start: {
        line: start.line - 1,
        character: start.column - 1,
      },
      end: {
        line: end.line - 1,
        character: end.column - 1,
      },
      properties: {
        class: `awdty--${resolutionType}`,
        'data-status': tooltipData.status,
        'data-trace': JSON.stringify(tooltipData.trace),
        'data-tokens': JSON.stringify(tooltipData.tokens),
        'data-source': JSON.stringify(tooltipData.source),
        'data-unresolved': JSON.stringify(tooltipData.unresolved),
        tabindex: '0',
        role: 'button',
        'aria-describedby': 'token-tooltip',
      },
    });
  }

  const html = await codeToHtml(content, {
    lang: 'css',
    theme: 'slack-ochin',
    tabindex: false,
    decorations,
    transformers: [
      {
        /**
         * Adds a `data-line` attribute and unique `id` to each line for line highlighting.
         *
         * @param {import('hast').Element} node - The HAST line node.
         * @param {number} line - The line number.
         */
        line(node, line) {
          const existing = node.properties.class;
          let existingClassList = [];

          if (Array.isArray(existing)) {
            existingClassList = existing;
          } else if (typeof existing === 'string') {
            existingClassList = existing.split(' ');
          }

          node.properties.id = `L${line}`;
          node.properties['data-line'] = String(line);
          node.properties.class = [...existingClassList, 'line-numbered'];
        },
      },
    ],
  });

  return html;
}

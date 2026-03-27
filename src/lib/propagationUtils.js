import fs from 'node:fs/promises';
import path from 'path';
import config from '../../config.js';
import { minimatch } from 'minimatch';

import { parseCSS } from './cssParser.js';
import {
  isVariableDefinition,
  isTokenizableProperty,
  isWithinValidParentSelector,
  extractDesignTokenIdsFromDecl,
} from './tokenUtils.js';

import { getExternalVars, getVarData } from './externalVars.js';
import {
  buildResolutionTrace,
  analyzeTrace,
  getResolutionSources,
  getUnresolvedVariablesFromTrace,
  classifyResolutionFromTrace,
  getResolvedVarOrigins,
} from './resolutionUtils.js';

import { UnresolvedVarTracker } from './trackUnresolvedVars.js';

/**
 * Convert an absolute file path to a repo-relative path for output.
 * Falls back to the original path if it cannot be relativized.
 * @param {string} absolutePath
 * @returns {string}
 */
export function normalizePathForOutput(absolutePath) {
  try {
    if (!absolutePath || typeof absolutePath !== 'string') {
      return absolutePath;
    }
    const relative = path.relative(config.repoPath, absolutePath);
    return relative && !relative.startsWith('..')
      ? relative.replace(/^[/\\]/, '')
      : absolutePath;
  } catch {
    return absolutePath;
  }
}

/**
 * Analyzes a CSS file to determine the percentage of properties using design tokens.
 *
 * This includes:
 * - Extracting and resolving CSS custom properties
 * - Identifying token usage
 * - Tracking unresolved variables
 * - Calculating a token usage percentage
 *
 * @param {string} filePath - Absolute path to the CSS file.
 * @returns {Promise<{
 *   designTokenCount: number,
 *   foundProps: number,
 *   percentage: number,
 *   foundPropValues: object[],
 *   foundVariables: object
 * }>} - Summary object including token count, percentage, and annotated data.
 */
export async function getPropagationData(filePath) {
  try {
    const foundVariables = await collectExternalVars(filePath);
    const root = await parseCSS(filePath);

    const foundPropValues = collectDeclarations(root, foundVariables, filePath);

    await resolveDeclarationReferences(
      foundPropValues,
      foundVariables,
      filePath,
    );

    const { designTokenCount, ignoredValueCount } =
      computeDesignTokenSummary(foundPropValues);

    const foundLessIgnored = foundPropValues.length - ignoredValueCount;

    let percentage = -1;
    if (foundPropValues.length && foundLessIgnored !== 0) {
      const ratio = designTokenCount / foundLessIgnored;
      percentage = +(ratio * 100).toFixed(2);
    }

    return {
      designTokenCount,
      foundProps: foundPropValues.length,
      percentage,
      foundPropValues,
      foundVariables,
    };
  } catch (err) {
    console.error(`Unable to read or parse ${filePath} ${err.message}`);
    throw new Error(err);
  }
}

/**
 * Collects external variables for a given file based on pattern matching from config.
 *
 * Skips external files that are the same as the input file.
 *
 * @param {string} filePath - The file path to match against config.externalVarMapping.
 * @returns {Promise<object>} - Map of variable names to external variable metadata.
 */
async function collectExternalVars(filePath) {
  let foundVariables = {};

  for (const pattern in config.externalVarMapping) {
    if (minimatch(filePath, `**/${pattern}`)) {
      for (const externalRelPath of config.externalVarMapping[pattern]) {
        const externalAbsPath = path.resolve(
          path.join(config.repoPath, externalRelPath),
        );

        if (externalAbsPath === filePath) {
          console.log(`Skipping var extraction from ${externalRelPath}`);
          continue;
        }

        let extVars = {};
        try {
          await fs.access(externalAbsPath, fs.constants.R_OK);
          extVars = await getExternalVars(externalAbsPath);
        } catch (e) {
          console.log(
            `${externalRelPath} doesn't exist, skipping... ${e.message}`,
          );
        }

        foundVariables = { ...foundVariables, ...extVars };
      }
    }
  }

  return foundVariables;
}

/**
 * Checks whether a CSS rule (the parent of a declaration node) actually uses
 * the custom property that the node defines.
 *
 * This function only applies to nodes of type `"decl"` whose `prop`
 * represents a variable definition (as determined by `isVariableDefinition`).
 * It converts the parent rule to a string and looks for the literal
 * `var(<prop>)` usage.
 *
 * @param {object} node - A PostCSS AST node.
 * @param {'decl'} node.type - The node type (should be "decl").
 * @param {string} node.prop - The property name (e.g. "--my-var").
 * @param {object} node.parent - The parent rule node.
 * @returns {boolean|undefined} `true` if the parent rule string includes
 *   `var(<prop>)`, `false` if not, or `undefined` if the node is not a
 *   variable declaration.
 */
function ruleConsumesVar(node) {
  if (node.type === 'decl' && isVariableDefinition(node.prop)) {
    const ruleString = node.parent.toString();
    return ruleString.includes(`var(${node.prop})`);
  }
}

/**
 * Checks whether a comment node is a Stylelint disable-next-line directive
 * specifically targeting the `stylelint-plugin-mozilla/use-design-tokens` rule.
 *
 * This is used to detect intentional rule suppression comments like:
 * "stylelint-disable-next-line stylelint-plugin-mozilla/use-design-tokens"
 *
 * @param {object} comment - The AST comment node to evaluate.
 * @param {string} comment.type - The node type (expected to be "comment").
 * @param {string} comment.text - The raw text content of the comment.
 * @returns {boolean} True if the comment disables the specified Stylelint rule on the next line; otherwise false.
 */
function isStylelintDisableNextLine(comment) {
  return (
    comment.type === 'comment' &&
    /^stylelint-disable-next-line\s+stylelint-plugin-mozilla\/use-design-tokens/.test(
      comment.text.trim(),
    )
  );
}

/**
 * Determines whether a given comment appears immediately before a node,
 * i.e., on the exact previous line in the source file.
 *
 * This relies on source location metadata.
 *
 * @param {object} node - The AST node to check against.
 * @param {object} comment - The AST comment node.
 *
 * @returns {boolean} True if the comment is exactly one line above the node; otherwise false.
 */
function isExactPreviousLine(node, comment) {
  return node.source?.start?.line === comment.source?.end?.line + 1;
}

/**
 * Walks the CSS AST and collects:
 * - Tokenizable properties (e.g. `color`, `font-size`)
 * - Variable definitions (`--*`) that are not external
 *
 * Adds new local variables to `foundVariables`.
 *
 * @param {import('postcss').Root} root - Parsed CSS AST.
 * @param {object} foundVariables - Accumulator object for collected variables.
 * @param {string} filePath - Path to the file being analyzed.
 * @returns {object[]} - Array of property declaration objects.
 */
function collectDeclarations(root, foundVariables, filePath) {
  const declarations = [];

  root.walk((node) => {
    if (!node.prop || !node.value) {
      return;
    }

    if (isTokenizableProperty(node.prop)) {
      let isExcludedByStylelint = false;
      const prevNode = node.prev();
      if (
        prevNode &&
        isStylelintDisableNextLine(prevNode) &&
        isExactPreviousLine(node, prevNode)
      ) {
        isExcludedByStylelint = true;
      }

      declarations.push({
        isExcludedByStylelint,
        prop: node.prop,
        value: node.value,
        start: node.source.start,
        end: node.source.end,
      });
    } else if (
      isVariableDefinition(node.prop) &&
      (isWithinValidParentSelector(node) || ruleConsumesVar(node))
    ) {
      if (foundVariables[node.prop]) {
        console.log(
          `${path.relative(config.repoPath, filePath)}:${node.source.start.line} "${node.prop}" already exists, skipping...`,
        );
      } else {
        foundVariables[node.prop] = getVarData(node, { isExternal: false });
      }
    }
  });

  return declarations;
}

// Track unresolved variables and token usage globally within this run.
const tracker = new UnresolvedVarTracker();

/** @type {Array<{ path: string, property: string, value: string, containsToken: boolean, isIgnored: boolean, tokens?: string[] }>} */
const usageFindingsBuffer = [];
const TOKEN_KEY_SET = new Set(
  Array.isArray(config.designTokenKeys) ? config.designTokenKeys : [],
);

/**
 * Resolves variable references for each declaration, attaches trace data,
 * and annotates with token usage, source origins, and unresolved variable info.
 *
 * Writes an unresolved variable report to `src/data/unresolvedVars.json`.
 *
 * @param {object[]} declarations - Declarations to resolve and annotate.
 * @param {object} foundVariables - Known variables available for resolution.
 * @param {string} filePath - Path of the file being analyzed.
 * @returns {Promise<void>}
 */
async function resolveDeclarationReferences(
  declarations,
  foundVariables,
  filePath,
) {
  for (const decl of declarations) {
    const trace = buildResolutionTrace(decl.value, foundVariables);
    const analysis = analyzeTrace(trace, decl.prop);

    decl.resolutionTrace = trace;
    decl.containsDesignToken = analysis.containsDesignToken;
    decl.isExcluded =
      analysis.containsExcludedDeclaration || decl.isExcludedByStylelint;

    const isIgnoredValue =
      Boolean(analysis.containsExcludedDeclaration) &&
      !analysis.containsDesignToken;

    decl.isExternalVar = trace.some((val) =>
      Object.values(foundVariables).some(
        (ref) => ref.isExternal && ref.value === val,
      ),
    );

    decl.resolutionSources = getResolutionSources(
      trace,
      foundVariables,
      filePath,
    );

    decl.unresolvedVariables = getUnresolvedVariablesFromTrace(
      trace,
      foundVariables,
    );

    tracker.addFromDeclaration(decl, filePath);

    decl.resolutionType = classifyResolutionFromTrace(
      trace,
      foundVariables,
      filePath,
    );

    decl.resolvedFrom = getResolvedVarOrigins(trace, foundVariables, filePath);

    // Capture all tokens, preserving duplicates for accurate frequency counting.
    const tokenIds = extractDesignTokenIdsFromDecl(decl, TOKEN_KEY_SET);
    if (tokenIds.length > 0) {
      decl.tokens = tokenIds;
    }

    usageFindingsBuffer.push({
      path: filePath,
      property: decl.prop,
      value: decl.value,
      containsToken: Boolean(decl.containsDesignToken),
      isIgnored: isIgnoredValue,
      ...(tokenIds.length > 0 ? { tokens: tokenIds } : {}),
    });
  }

  const unresolvedReport = tracker.toReport();
  const { tokenUsage, propertyValues } =
    buildUsageAggregates(usageFindingsBuffer);

  // Create ./build/data dir.
  await fs.mkdir('./build/data', { recursive: true });

  await Promise.all([
    fs.writeFile(
      path.join('./src/data', 'unresolvedVars.json'),
      JSON.stringify(unresolvedReport, null, 2),
    ),
    fs.writeFile(
      path.join('./src/data', 'tokenUsage.json'),
      JSON.stringify(tokenUsage, null, 2),
    ),
    // Write directly to build/data.
    fs.writeFile(
      path.join('./build/data', 'propertyValues.json'),
      JSON.stringify(propertyValues, null, 2),
    ),
  ]);
}

/**
 * Computes summary statistics from the resolved declarations:
 * - Number of declarations using design tokens
 * - Number of ignored values (excluded tokens without design tokens)
 *
 * @param {object[]} declarations - List of annotated declarations.
 * @returns {{ designTokenCount: number, ignoredValueCount: number }}
 */
function computeDesignTokenSummary(declarations) {
  return {
    designTokenCount: declarations.filter((d) => d.containsDesignToken).length,
    ignoredValueCount: declarations.filter(
      (d) => d.isExcluded && !d.containsDesignToken,
    ).length,
  };
}

/**
 * Build token and property aggregates from a list of findings.
 *
 * @param {Array<{ path: string, property: string, value: string, containsToken: boolean, isIgnored: boolean, tokens?: string[] }>} usageFindings
 * @returns {{
 *   tokenUsage: {
 *     byToken: Record<string, {
 *       total: number,
 *       files: Record<string, number>,
 *       properties: Record<string, number>,
 *     }>,
 *     generatedAt: string,
 *   },
 *   propertyValues: {
 *     byProperty: Record<string, {
 *       id?: string,
 *       values: Record<string, {
 *         id?: string,
 *         count: number,
 *         containsToken: boolean,
 *         isIgnored: boolean,
 *         tokens?: string[],
 *         files: Record<string, number>,
 *       }>,
 *     }>,
 *     generatedAt: string,
 *   }
 * }}
 */
export function buildUsageAggregates(usageFindings) {
  const generatedAt = new Date().toISOString();

  const tokenUsage = {
    byToken: {},
    generatedAt,
  };

  const propertyValues = {
    byProperty: {},
    generatedAt,
  };

  for (const finding of usageFindings) {
    const relativePath = normalizePathForOutput(finding.path);

    // ---- property-centric aggregation ----
    const propertyEntry =
      propertyValues.byProperty[finding.property] ??
      (propertyValues.byProperty[finding.property] = {
        values: {},
      });

    const valueEntry =
      propertyEntry.values[finding.value] ??
      (propertyEntry.values[finding.value] = {
        count: 0,
        containsToken: finding.containsToken,
        isIgnored: finding.isIgnored,
        ...(Array.isArray(finding.tokens) && finding.tokens.length > 0
          ? { tokens: finding.tokens }
          : {}),
        files: {},
      });

    valueEntry.count += 1;
    if (finding.isIgnored) {
      valueEntry.isIgnored = true;
    }
    valueEntry.files[relativePath] = (valueEntry.files[relativePath] ?? 0) + 1;

    // ---- token-centric aggregation (count every occurrence)
    if (Array.isArray(finding.tokens)) {
      for (const tokenId of finding.tokens) {
        const tokenEntry =
          tokenUsage.byToken[tokenId] ??
          (tokenUsage.byToken[tokenId] = {
            total: 0,
            files: {},
            properties: {},
          });

        tokenEntry.total += 1;

        // files: per-file occurrence count
        tokenEntry.files[relativePath] =
          (tokenEntry.files[relativePath] ?? 0) + 1;

        // properties: global occurrence count per property
        tokenEntry.properties[finding.property] =
          (tokenEntry.properties[finding.property] ?? 0) + 1;
      }
    }
  }

  // Assign compact numeric IDs to properties and values for deterministic lookup.
  let nextId = 0;
  const propertyNames = Object.keys(propertyValues.byProperty).sort();
  for (const propertyName of propertyNames) {
    const propertyEntry = propertyValues.byProperty[propertyName];
    propertyEntry.id = String(nextId++);
    const valueKeys = Object.keys(propertyEntry.values).sort();
    for (const valueKey of valueKeys) {
      propertyEntry.values[valueKey].id = String(nextId++);
    }
  }

  return { tokenUsage, propertyValues };
}

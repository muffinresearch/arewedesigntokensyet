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
      declarations.push({
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

/** @type {Array<{ path: string, descriptor: string, value: string, containsToken: boolean, isIgnored: boolean, tokens?: string[] }>} */
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
    decl.isExcluded = analysis.containsExcludedDeclaration;

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
      descriptor: decl.prop,
      value: decl.value,
      containsToken: Boolean(decl.containsDesignToken),
      isIgnored: isIgnoredValue,
      ...(tokenIds.length > 0 ? { tokens: tokenIds } : {}),
    });
  }

  const unresolvedReport = tracker.toReport();
  const { tokenUsage, descriptorValues } =
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
      path.join('./build/data', 'descriptorValues.json'),
      JSON.stringify(descriptorValues, null, 2),
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
 * Build token and descriptor aggregates from a list of findings.
 *
 * @param {Array<{ path: string, descriptor: string, value: string, containsToken: boolean, isIgnored: boolean, tokens?: string[] }>} usageFindings
 * @returns {{
 *   tokenUsage: {
 *     byToken: Record<string, {
 *       total: number,
 *       files: Record<string, number>,
 *       descriptors: Record<string, number>,
 *     }>,
 *     generatedAt: string,
 *     schemaVersion: number,
 *   },
 *   descriptorValues: {
 *     byDescriptor: Record<string, {
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
 *     schemaVersion: number,
 *   }
 * }}
 */
export function buildUsageAggregates(usageFindings) {
  const generatedAt = new Date().toISOString();

  const tokenUsage = {
    byToken: {},
    generatedAt,
    schemaVersion: 1,
  };

  const descriptorValues = {
    byDescriptor: {},
    generatedAt,
    schemaVersion: 1,
  };

  for (const finding of usageFindings) {
    const relativePath = normalizePathForOutput(finding.path);

    // ---- descriptor-centric aggregation ----
    const descriptorEntry =
      descriptorValues.byDescriptor[finding.descriptor] ??
      (descriptorValues.byDescriptor[finding.descriptor] = {
        values: {},
      });

    const valueEntry =
      descriptorEntry.values[finding.value] ??
      (descriptorEntry.values[finding.value] = {
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
            descriptors: {},
          });

        tokenEntry.total += 1;

        // files: per-file occurrence count
        tokenEntry.files[relativePath] =
          (tokenEntry.files[relativePath] ?? 0) + 1;

        // descriptors: global occurrence count per descriptor
        tokenEntry.descriptors[finding.descriptor] =
          (tokenEntry.descriptors[finding.descriptor] ?? 0) + 1;
      }
    }
  }

  // Assign compact numeric IDs to descriptors and values for deterministic lookup.
  let nextId = 0;
  const descriptorNames = Object.keys(descriptorValues.byDescriptor).sort();
  for (const descriptorName of descriptorNames) {
    const descriptorEntry = descriptorValues.byDescriptor[descriptorName];
    descriptorEntry.id = String(nextId++);
    const valueKeys = Object.keys(descriptorEntry.values).sort();
    for (const valueKey of valueKeys) {
      descriptorEntry.values[valueKey].id = String(nextId++);
    }
  }

  return { tokenUsage, descriptorValues };
}

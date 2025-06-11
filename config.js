import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const repoPath =
  process.env.MOZILLA_CENTRAL_REPO_PATH || '../mozilla-unified';

// pathToFileURL ensures a x-platform path for the dynamic import
// otherwise this will fail on windows with
// ERR_UNSUPORTED_ESM_URL_SCHEME
const tokensPath = pathToFileURL(
  path.join(
    repoPath,
    '/toolkit/themes/shared/design-system/tokens-storybook.mjs',
  ),
);

let designTokenKeys;

// If we're backfilling old data from the Firefox tree go far enough back and the
// Storybook tables won't exist. Hence this mechanism allows us to using a backup
// json file of design token keys.
try {
  await fs.access(tokensPath, fs.constants.R_OK);
  const { storybookTables } = await import(tokensPath);
  designTokenKeys = Object.values(storybookTables).flatMap((list) =>
    list.map((item) => item.name),
  );
  console.log(
    `Using '/toolkit/themes/shared/design-system/tokens-storybook.mjs' as token source`,
  );
  // eslint-disable-next-line no-unused-vars
} catch (error) {
  console.warn(
    `Can't find "tokens-storybook.mjs" This is either and old revision or we're running tests. Falling back to use the backup src/data/tokensBackup.json`,
  );
  const backupPath = pathToFileURL(path.join('./src/data/tokensBackup.json'));
  const designTokenKeysImport = await import(backupPath, {
    with: { type: 'json' },
  });
  designTokenKeys = designTokenKeysImport.default;
}

export default {
  repoPath,
  // These are the properties we look for, and expect to utilize design tokens.
  designTokenProperties: [
    'background-color',
    'border',
    'border-block-end',
    'border-block-end-color',
    'border-block-end-width',
    'border-block-start',
    'border-block-start-color',
    'border-block-start-width',
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-color',
    'border-width',
    'border-radius',
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-left-radius',
    'border-bottom-right-radius',
    'border-inline',
    'border-inline-color',
    'border-inline-end',
    'border-inline-end-color',
    'border-inline-end-width',
    'border-inline-start',
    'border-inline-start-color',
    'border-inline-start-width',
    'border-inline-width',
    'border-start-end-radius',
    'border-start-start-radius',
    'border-end-start-radius',
    'border-end-end-radius',
    'box-shadow',
    'color',
    'fill',
    'font-size',
    'font-weight',
    'inset',
    'inset-block',
    'inset-block-end',
    'inset-block-start',
    'inset-inline',
    'inset-inline-end',
    'inset-inline-start',
    'gap',
    'grid-gap', // Deprecated in favour of gap but still used.
    'margin',
    'margin-block',
    'margin-block-end',
    'margin-block-start',
    'margin-inline',
    'margin-inline-end',
    'margin-inline-start',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'opacity',
    'outline',
    'outline-offset',
    'padding',
    'padding-block',
    'padding-block-end',
    'padding-block-start',
    'padding-inline',
    'padding-inline-end',
    'padding-inline-start',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'row-gap',
  ],
  designTokenKeys,
  // Globs to find CSS to get design token propagation data for.
  includePatterns: [
    'browser/components/**/*.css',
    // Add New Tab directory path (note: located in browser/components/ dir)
    'browser/extensions/newtab/css/**/*.css',
    'browser/themes/**/*.css',
    'toolkit/content/widgets/**/*.css',
    'toolkit/themes/**/*.css',
  ],
  externalVarMapping: {
    // For everything that matches the glob on the left hand side, get the vars from
    // each file in the list on the right hand side. Files in the RHS list are ignored
    // during processing.
    'browser/components/aboutlogins/content/components/*.css': [
      'browser/components/aboutlogins/content/aboutLogins.css',
    ],
    'browser/components/firefoxview/*.css': [
      'browser/components/firefoxview/firefoxview.css',
    ],
    'browser/components/sidebar/*.css': [
      'browser/components/sidebar/sidebar.css',
    ],
    'toolkit/content/widgets/moz-box-*/*.css': [
      'toolkit/content/widgets/moz-box-common.css',
    ],
    'toolkit/content/widgets/moz-page-nav/*.css': [
      'toolkit/content/widgets/moz-page-nav/moz-page-nav.css',
    ],
  },
  // Paths in the repo matching these glob patterns will be ignored to avoid generating
  // coverage for storybook files, tests and node deps.
  ignorePatterns: ['**/test{,s}/**', '**/node_modules/**', '**/storybook/**'],
  // supports RegExp or string.
  excludedCSSValues: [
    0,
    1,
    'auto',
    'currentColor',
    'inherit',
    'initial',
    'none',
    'transparent',
    'unset',
    /calc(.*?)/,
    /max(.*?)/,
  ],
};

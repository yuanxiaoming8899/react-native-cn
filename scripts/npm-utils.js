/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

const {
  exitIfNotOnGit,
  getCurrentCommit,
  isTaggedLatest,
} = require('./scm-utils');
const {parseVersion} = require('./version-utils');
const {exec} = require('shelljs');

/*::
import type { ExecOptsSync, ShellString } from 'shelljs';

type BuildType = 'dry-run' | 'release' | 'nightly' | 'prealpha';
type NpmInfo = {
  version: string,
  tag: ?string,
}
type PackageJSON = {
  name: string,
  version: string,
  dependencies: {[string]: string},
  devDependencies: {[string]: string},
  ...
}
type NpmPackageOptions = {
  tags: ?Array<string>,
  otp: ?string,
}
*/

// Get `next` version from npm and +1 on the minor for `main` version
function getMainVersion() {
  const versionStr = getPackageVersionStrByTag('react-native', 'next');
  const {major, minor} = parseVersion(versionStr, 'release');
  return `${major}.${parseInt(minor, 10) + 1}.0`;
}

function getNpmInfo(buildType /*: BuildType */) /*: NpmInfo */ {
  const currentCommit = getCurrentCommit();
  const shortCommit = currentCommit.slice(0, 9);

  if (buildType === 'dry-run') {
    return {
      version: `1000.0.0-${shortCommit}`,
      tag: null, // We never end up publishing this
    };
  }

  if (buildType === 'nightly') {
    const mainVersion = getMainVersion();
    const dateIdentifier = new Date()
      .toISOString()
      .slice(0, -14)
      .replace(/[-]/g, '');
    return {
      version: `${mainVersion}-nightly-${dateIdentifier}-${shortCommit}`,
      tag: 'nightly',
    };
  }

  if (buildType === 'prealpha') {
    const mainVersion = '0.0.0';
    // Date in the format of YYYYMMDDHH.
    // This is a progressive int that can track subsequent
    // releases and it is smaller of 2^32-1.
    // It is unlikely that we can trigger two prealpha in less
    // than an hour given that nightlies take ~ 1 hr to complete.
    const dateIdentifier = new Date()
      .toISOString()
      .slice(0, -10)
      .replace(/[-T:]/g, '');

    return {
      version: `${mainVersion}-prealpha-${dateIdentifier}`,
      tag: 'prealpha',
    };
  }

  if (buildType === 'release') {
    if (process.env.CIRCLE_TAG == null) {
      throw new Error(
        'CIRCLE_TAG is not set for release. This should only be run in CircleCI. See https://circleci.com/docs/variables/ for how CIRCLE_TAG is set.',
      );
    }

    const {version, major, minor, prerelease} = parseVersion(
      process.env.CIRCLE_TAG,
      buildType,
    );

    // See if releaser indicated that this version should be tagged "latest"
    // Set in `trigger-react-native-release`
    const isLatest = exitIfNotOnGit(
      () => isTaggedLatest(currentCommit),
      'Not in git. We do not want to publish anything',
    );

    const releaseBranchTag = `${major}.${minor}-stable`;

    // npm will automatically tag the version as `latest` if no tag is set when we publish
    // To prevent this, use `releaseBranchTag` when we don't want that (ex. releasing a patch on older release)
    const tag =
      prerelease != null
        ? 'next'
        : isLatest === true
        ? 'latest'
        : releaseBranchTag;

    return {
      version,
      tag,
    };
  }

  throw new Error(`Unsupported build type: ${buildType}`);
}

function publishPackage(
  packagePath /*: string */,
  packageOptions /*: NpmPackageOptions */,
  execOptions /*: ?ExecOptsSync */,
) /*: ShellString */ {
  const {otp, tags} = packageOptions;
  const tagsFlag = tags != null ? tags.map(t => ` --tag ${t}`).join('') : '';
  const otpFlag = otp != null ? ` --otp ${otp}` : '';
  const options = execOptions
    ? {...execOptions, cwd: packagePath}
    : {cwd: packagePath};

  return exec(`npm publish${tagsFlag}${otpFlag}`, options);
}

function diffPackages(
  packageSpecA /*: string */,
  packageSpecB /*: string */,
  options /*:  ExecOptsSync */,
) /*: string */ {
  const result = exec(
    `npm diff --diff=${packageSpecA} --diff=${packageSpecB} --diff-name-only`,
    options,
  );

  if (result.code !== 0) {
    throw new Error(
      `Failed to diff ${packageSpecA} and ${packageSpecB}\n${result.stderr}`,
    );
  }

  return result.stdout;
}

function pack(packagePath /*: string */) {
  const result = exec('npm pack', {
    cwd: packagePath,
  });

  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
}

/**
 * `package` is an object form of package.json
 * `dependencies` is a map of dependency to version string
 *
 * This replaces both dependencies and devDependencies in package.json
 */
function applyPackageVersions(
  originalPackageJson /*: PackageJSON */,
  packageVersions /*: {[string]: string} */,
) /*: PackageJSON */ {
  const packageJson = {...originalPackageJson};

  for (const name of Object.keys(packageVersions)) {
    if (
      packageJson.dependencies != null &&
      packageJson.dependencies[name] != null
    ) {
      packageJson.dependencies[name] = packageVersions[name];
    }

    if (
      packageJson.devDependencies != null &&
      packageJson.devDependencies[name] != null
    ) {
      packageJson.devDependencies[name] = packageVersions[name];
    }
  }
  return packageJson;
}

/**
 * `packageName`: name of npm package
 * `tag`: npm tag like `latest` or `next`
 *
 * This will fetch version of `packageName` with npm tag specified
 */
function getPackageVersionStrByTag(
  packageName /*: string */,
  tag /*: ?string */,
) /*: string */ {
  const npmString =
    tag != null
      ? `npm view ${packageName}@${tag} version`
      : `npm view ${packageName} version`;
  const result = exec(npmString, {silent: true});

  if (result.code) {
    throw new Error(`Failed to run '${npmString}'\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * `packageName`: name of npm package
 * `spec`: spec range ex. '^0.72.0'
 *
 * Return an array of versions of the specified spec range or throw an error
 */
function getVersionsBySpec(
  packageName /*: string */,
  spec /*: string */,
) /*: Array<string> */ {
  const npmString = `npm view ${packageName}@'${spec}' version --json`;
  const result = exec(npmString, {silent: true});

  if (result.code) {
    // Special handling if no such package spec exists
    if (result.stderr.includes('npm ERR! code E404')) {
      /**
       * npm ERR! code E404
       * npm ERR! 404 No match found for version ^0.72.0
       * npm ERR! 404
       * npm ERR! 404  '@react-native/community-cli-plugin@^0.72.0' is not in this registry.
       * npm ERR! 404
       * npm ERR! 404 Note that you can also install from a
       * npm ERR! 404 tarball, folder, http url, or git url.
       * {
       *   "error": {
       *     "code": "E404",
       *     "summary": "No match found for version ^0.72.0",
       *     "detail": "\n '@react-native/community-cli-plugin@^0.72.0' is not in this registry.\n\nNote that you can also install from a\ntarball, folder, http url, or git url."
       *   }
       * }
       */
      const error = JSON.parse(
        result.stderr
          .split('\n')
          .filter(line => !line.includes('npm ERR'))
          .join(''),
      ).error;
      throw new Error(error.summary);
    } else {
      throw new Error(`Failed: ${npmString}`);
    }
  }
  const versions = JSON.parse(result.stdout.trim());
  return !Array.isArray(versions) ? [versions] : versions;
}

module.exports = {
  applyPackageVersions,
  getNpmInfo,
  getPackageVersionStrByTag,
  getVersionsBySpec,
  publishPackage,
  diffPackages,
  pack,
};

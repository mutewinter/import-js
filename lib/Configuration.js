// @flow

import path from 'path';

import semver from 'semver';

import FileUtils from './FileUtils';
import JsModule from './JsModule';
import findPackageDependencies from './findPackageDependencies';
import meteorEnvironment from './environments/meteorEnvironment';
import nodeEnvironment from './environments/nodeEnvironment';
import normalizePath from './normalizePath';
import requireResolve from './requireResolve';
import version from './version';

const JSON_CONFIG_FILE = '.importjs.json';
const JS_CONFIG_FILE = '.importjs.js';

const DEFAULT_CONFIG = {
  aliases: {},
  declarationKeyword: 'import',
  coreModules: [],
  namedExports: {},
  environments: [],
  excludes: [],
  groupImports: true,
  ignorePackagePrefixes: [],
  importDevDependencies: false,
  importFunction: 'require',
  logLevel: 'info',
  maxLineLength: 80,
  minimumVersion: '0.0.0',
  moduleNameFormatter: ({ moduleName }: Object): string => moduleName,
  moduleSideEffectImports: (): Array<string> => [],
  stripFileExtensions: ['.js', '.jsx'],
  tab: '  ',
  packageDependencies: ({ config }: Object): Array<string> =>
    findPackageDependencies(
      config.workingDirectory,
      config.get('importDevDependencies')),
};

// Default configuration options, and options inherited from environment
// configuration are overridden if they appear in user config. Some options,
// however, get merged with the parent configuration. This list specifies which
// ones are merged.
const MERGABLE_CONFIG_OPTIONS = [
  'aliases',
  'coreModules',
  'namedExports',
];

const KNOWN_CONFIGURATION_OPTIONS = [
  'aliases',
  'coreModules',
  'declarationKeyword',
  'environments',
  'excludes',
  'groupImports',
  'ignorePackagePrefixes',
  'importDevDependencies',
  'importFunction',
  'logLevel',
  'maxLineLength',
  'minimumVersion',
  'moduleNameFormatter',
  'moduleSideEffectImports',
  'namedExports',
  'stripFileExtensions',
  'tab',
];

const ENVIRONMENTS = {
  node: nodeEnvironment,
  meteor: meteorEnvironment,
};

function checkForUnknownConfiguration(config: Object): Array<string> {
  const messages = [];

  Object.keys(config).forEach((option: string) => {
    if (KNOWN_CONFIGURATION_OPTIONS.indexOf(option) === -1) {
      messages.push(`Unknown configuration: \`${option}\``);
    }
  });

  return messages;
}

/**
  * Checks that the current version is bigger than the `minimumVersion`
  * defined in config.
  * @throws Error if current version is less than the `minimumVersion` defined
  * in config.
  */
function checkCurrentVersion(minimumVersion: string) {
  if (semver.gte(version(), minimumVersion)) {
    return;
  }

  throw Error(
    'The configuration file for this project requires version ' +
    `${minimumVersion} or newer. You are using ${version()}.`
  );
}

function mergedValue(
    values: Array<any>,
    key: string,
    options: Object
  ): any {
  let mergedResult;
  for (let i = 0; i < values.length; i++) {
    let value = values[i];
    if (typeof value === 'function') {
      value = value(options);
    }
    if (MERGABLE_CONFIG_OPTIONS.indexOf(key) === -1) {
      // This key shouldn't be merged
      return value;
    }
    if (Array.isArray(value)) {
      mergedResult = (mergedResult || []).concat(value);
    } else if (typeof value === 'object') {
      mergedResult = Object.assign(mergedResult || {}, value);
    } else {
      // Neither an object nor an array, so we just return the first value we
      // have.
      return value;
    }
  }
  return mergedResult;
}

// Class that initializes configuration from a .importjs.js file
export default class Configuration {
  pathToCurrentFile: string;
  messages: Array<string>;
  configs: Array<Object>;
  workingDirectory: string;

  constructor(
    pathToCurrentFile: string,
    workingDirectory: string = process.cwd()
  ) {
    this.workingDirectory = workingDirectory;
    this.pathToCurrentFile = normalizePath(pathToCurrentFile, workingDirectory);

    this.messages = [];
    this.configs = [];

    let userConfig;
    try {
      userConfig = this.loadUserConfig();
    } catch (error) {
      this.messages.push(
        `Unable to parse configuration file. Reason:\n${error.stack}`);
    }

    if (userConfig) {
      this.configs.push(userConfig);
      this.messages.push(...checkForUnknownConfiguration(userConfig));

      // Add configurations for the environments specified in the user config
      // file.
      (this.get('environments') || []).forEach((environment: string) => {
        this.configs.push(ENVIRONMENTS[environment]);
      });
    }

    this.configs.push(DEFAULT_CONFIG);

    checkCurrentVersion(this.get('minimumVersion'));
  }

  get(
    key: string,
    {
      pathToImportedModule,
      moduleName,
    }: {
      pathToImportedModule: string,
      moduleName?: string,
    } = {}
  ): any {
    const applyingConfigs = this.configs.filter((config: Object): boolean => (
      Object.prototype.hasOwnProperty.call(config, key)
    ));

    return mergedValue(
      applyingConfigs.map((config: Object): any => config[key]),
      key,
      {
        pathToImportedModule,
        moduleName,
        config: this,
        pathToCurrentFile: this.pathToCurrentFile,
      }
    );
  }

  loadUserConfig(): ?Object {
    const jsConfig = FileUtils.readJsFile(
      path.join(this.workingDirectory, JS_CONFIG_FILE)
    );

    if (jsConfig && Object.keys(jsConfig).length === 0) {
      // If you forget to use `module.exports`, the config object will be `{}`.
      // To prevent subtle errors from happening, we surface an error message to
      // the user.
      throw new Error(
        `Nothing exported from ${JS_CONFIG_FILE}. You need to use ` +
        '`module.exports` to specify what gets exported from the file.');
    }

    if (jsConfig) {
      return jsConfig;
    }

    const jsonConfig = FileUtils.readJsonFile(
      path.join(this.workingDirectory, JSON_CONFIG_FILE));

    if (jsonConfig) {
      this.messages.push(
        'Using JSON to configure ImportJS is deprecated and will go away ' +
        'in a future version. Use an `.importjs.js` file instead.');
    }

    return jsonConfig;
  }

  resolveAlias(variableName: string, pathToCurrentFile: ?string): ?JsModule {
    let importPath = this.get('aliases')[variableName];
    if (!importPath) {
      return null;
    }

    importPath = importPath.path || importPath; // path may be an object

    if (pathToCurrentFile && pathToCurrentFile.length) {
      // aliases can have dynamic `{filename}` parts
      importPath = importPath.replace(/\{filename\}/,
        path.basename(pathToCurrentFile, path.extname(pathToCurrentFile)));
    }
    return new JsModule({ importPath, variableName });
  }

  resolveNamedExports(variableName: string): ?JsModule {
    const allNamedExports = this.get('namedExports');
    const importPath = Object.keys(allNamedExports).find((key: string): boolean => (
      allNamedExports[key].indexOf(variableName) !== -1
    ));

    if (!importPath) {
      return undefined;
    }

    const relativeFilePath = requireResolve(importPath, this.workingDirectory);

    const jsModule = new JsModule({
      importPath,
      hasNamedExports: true,
      variableName,
    });

    if (
      relativeFilePath.startsWith('meteor/')
      || relativeFilePath.startsWith('node_modules/')
    ) {
      return jsModule;
    }

    jsModule.makeRelativeTo(this.pathToCurrentFile);
    return jsModule;
  }
}

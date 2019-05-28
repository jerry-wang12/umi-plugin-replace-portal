import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import semver from 'semver';
import crequire from 'crequire';
import upperCamelCase from 'uppercamelcase';
import { COVER_FOLDERS, SINGULAR_SENSLTIVE } from './constants';

const debug = require('debug')('umi-build-dev:getBlockGenerator');

export function getNameFromPkg(pkg) {
  if (!pkg.name) {
    return null;
  }
  return pkg.name.split('/').pop();
}

function checkConflict(blockDeps, projectDeps) {
  const lacks = [];
  const conflicts = [];
  Object.keys(blockDeps).forEach(dep => {
    if (!projectDeps[dep]) {
      lacks.push([dep, blockDeps[dep]]);
    } else if (!semver.intersects(projectDeps[dep], blockDeps[dep])) {
      conflicts.push([dep, blockDeps[dep], projectDeps[dep]]);
    }
  });
  return [lacks, conflicts];
}

export function getAllBlockDependencies(rootDir, pkg) {
  const { blockConfig = {}, dependencies = {} } = pkg;
  const { dependencies: depBlocks = [] } = blockConfig;
  const allDependencies = {};

  function mergeDependencies(parent, sub) {
    const [lacks, conflicts] = checkConflict(sub, parent);
    if (conflicts.length) {
      throw new Error(`
      find dependencies conflict between blocks:
      ${conflicts
        .map(info => {
          return `* ${info[0]}: ${info[2]} not compatible with ${info[1]}`;
        })
        .join('\n')}`);
    }
    lacks.forEach(lack => {
      const [name, version] = lack;
      parent[name] = version;
    });
    return parent;
  }

  depBlocks.forEach(block => {
    const rubBlockDeps = getAllBlockDependencies(
      rootDir,
      // eslint-disable-next-line
      require(join(rootDir, block, 'package.json'))
    );
    mergeDependencies(allDependencies, rubBlockDeps);
  });
  mergeDependencies(allDependencies, dependencies);
  return allDependencies;
}

export function dependenciesConflictCheck(
  blockPkgDeps = {},
  projectPkgDeps = {},
  blockPkgDevDeps = {},
  projectPkgAllDeps = {}
) {
  const [lacks, conflicts] = checkConflict(blockPkgDeps, projectPkgDeps);
  const [devLacks, devConflicts] = checkConflict(blockPkgDevDeps, projectPkgAllDeps);
  return {
    conflicts,
    lacks,
    devConflicts,
    devLacks
  };
}

export function getMockDependencies(mockContent, blockPkg) {
  const allDependencies = {
    ...blockPkg.devDependencies,
    ...blockPkg.dependencies
  };
  const deps = {};
  try {
    crequire(mockContent).forEach(item => {
      if (allDependencies[item.path]) {
        deps[item.path] = allDependencies[item.path];
      }
    });
  } catch (e) {
    debug('parse mock content failed');
    debug(e);
  }

  return deps;
}

const singularReg = new RegExp(`[\'\"](@\/|[\\.\/]+)(${SINGULAR_SENSLTIVE.join('|')})\/`, 'g');

export function parseContentToSingular(content) {
  return content.replace(singularReg, (all, prefix, match) => {
    return all.replace(match, match.replace(/s$/, ''));
  });
}

export function getSingularName(name) {
  if (SINGULAR_SENSLTIVE.includes(name)) {
    name = name.replace(/s$/, '');
  }
  return name;
}

export default api => {
  const { paths, Generator, config, applyPlugins } = api;

  return class BlockGenerator extends Generator {
    constructor(args, opts) {
      super(args, opts);

      this.sourcePath = opts.sourcePath;
      this.dryRun = opts.dryRun;
      this.path = opts.path;
      this.blockName = opts.blockName;
      this.blockFolderName = upperCamelCase(this.blockName);
      this.entryPath = null;

      this.on('error', e => {
        debug(e); // handle the error for aviod throw generator default error stack
      });
    }

    async writing() {
      const blockPath = this.path;

      applyPlugins('beforeBlockWriting', {
        args: {
          sourcePath: this.sourcePath,
          blockPath
        }
      });

      if (this.dryRun) {
        debug('dryRun is true, skip copy files');
        return;
      }

      // copy block to target
      // you can find the copy api detail in https://github.com/SBoudrias/mem-fs-editor/blob/master/lib/actions/copy.js
      debug('start copy block file to your project...');
      COVER_FOLDERS.forEach(folder => {
        const folderPath = join(this.sourcePath, 'src', folder);
        const targetFolder = join(paths.absSrcPath, folder);
        const options = {
          process(content, targetPath) {
            content = String(content);
            if (config.singular) {
              content = parseContentToSingular(content);
            }
            return applyPlugins('_modifyBlockFile', {
              initialValue: content,
              args: {
                blockPath,
                targetPath
              }
            });
          }
        };
        if (existsSync(folderPath)) {
          readdirSync(folderPath).forEach(name => {
            // ignore the dot files
            if (name.charAt(0) === '.') {
              return;
            }
            const thePath = join(folderPath, name);
            // 单数形式目录的转换
            if (statSync(thePath).isDirectory() && config.singular) {
              // @/components/ => @/src/component/ and ./components/ => ./component etc.
              name = getSingularName(name);
            }
            const realTarget = applyPlugins('_modifyBlockTarget', {
              initialValue: join(targetFolder, name),
              args: {
                source: thePath,
                blockPath,
                sourceName: name
              }
            });
            debug(`copy ${thePath} to ${realTarget}`);
            this.fs.copy(thePath, realTarget, options);
          });
        }
      });
    }
  };
};

const traverse = require('traverse');

const { get, transform, isEqual } = require('lodash');

const { getDataPathsForRefPath } = require('../util/path-utils');

const nameProp = 'fn';
const argsProp = 'args';

function collectArrayValues(pathStr, data) {
  const results = [];
  const dataPaths = getDataPathsForRefPath(pathStr, data);
  dataPaths.forEach(path => {
    results.push(get(data, path));
  });
  return results;
}

function applyRelativeIndexes(pathStr = '', targetPath = []) {
  const pathArr = pathStr.split('.');
  return pathArr.map((token, index) => {
    if (token === '^') {
      return targetPath[index];
    }
    return token;
  }).join('.');
}

function resolveString(string, data, context = {}, targetPath) {
  if (string === '$value') {
    if (targetPath) {
      return get(data, targetPath);
    }
    console.warn('$value specified, but no targetPath defined');
  }
  if (string.indexOf('$.') === 0) {
    let pathStr = string;
    if (pathStr.indexOf('^') !== -1) {
      pathStr = '$.' + applyRelativeIndexes(pathStr.replace('$.', ''), targetPath);
    }
    if (pathStr.indexOf('*') !== -1) {
      return collectArrayValues(pathStr, data);
    }
    return get(data, pathStr.replace('$.', ''));
  }
  return string;
}

module.exports = function resolve(resolvable, data, context, targetPath) {
  if (typeof context[resolvable[nameProp]] === 'function') {
    const args = (Array.isArray(resolvable[argsProp]) ? resolvable[argsProp] : []);
    // console.log('applying:', resolvable[nameProp], 'with:', args.map(arg => resolve(arg, data, context, targetPath)));
    return context[resolvable[nameProp]]
      .apply(null, args.map(arg => resolve(arg, data, context, targetPath)));
  }
  if (typeof resolvable === 'string') {
    return resolveString(resolvable, data, context, targetPath);
  }
  if (Array.isArray(resolvable)) {
    return resolvable.map(item => resolve(item, data, context, targetPath));
  }
  if (typeof resolvable === 'object') {
    return transform(resolvable, (memo, value, prop) => {
      memo[prop] = resolve(value, data, context, targetPath);
      return memo;
    }, {});
  }
  return resolvable;
}
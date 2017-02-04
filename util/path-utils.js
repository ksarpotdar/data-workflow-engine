const traverse = require('traverse');

function matches(refPath = [], dataPath = []) {
  return refPath.length === dataPath.length && refPath.reduce((memo, token, index) => {
    const dataPathToken = dataPath[index];
    return memo && (dataPathToken === token || (token === '*' && dataPathToken.match(/\d/)));
  }, true);
}

module.exports.getDataPathsForRefPath = function getDataPathsForRefPath(path, data) {
  const paths = [];
  const refPathArr = path.replace('$.', '').split('.');
  traverse(data).forEach(function (node) {
    if (matches(refPathArr, this.path)) {
      paths.push(this.path);
    }
  });
  return paths;
};

module.exports.getRefPathForDataPath = function getRefPathForDataPath(dataPath = []) {
  return dataPath.reduce((memo, prop) => {
    return `${memo}.${!isNaN(prop) ? '*' : prop}`;
  }, '$').replace(/\.\*$/, ''); // remove trailing '.*'
}

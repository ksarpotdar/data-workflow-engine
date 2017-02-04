const { cloneDeep, merge, set, get, find } = require('lodash');
const traverse = require('traverse');
const toposort = require('toposort');

const resolve = require('./resolver');
const DataDescriptor = require('./data-descriptor');
const prettyJSON = require('./util/pretty-json');
const {
  getDataPathsForRefPath,
  getRefPathForDataPath
} = require('./util/path-utils');
const defaultContext = require('./context');

module.exports = {
  create: function(config, context) {
    return new DataEngine(config, context);
  }
};

function DataEngine(c, ctx = {}) {
  const config = DataDescriptor.create(cloneDeep(c));
  const context = merge({}, defaultContext, ctx);
  const preconditionOrder = orderPreconditions(config);

  this.getConfig = function getConfig() {
    return config;
  };

  this.getContext = function getContext() {
    return context;
  };

  this.getPreconditionOrder = function getPreconditionOrder() {
    return preconditionOrder;
  }
}

DataEngine.prototype.getWorkflowState = function (data) {
  const prunedData = pruneData(data, this.getConfig(), this.getPreconditionOrder(), this.getContext());
  const sectionStates = evaluateSectionStates(prunedData, this.getConfig(), this.getContext());
  return {
    data: prunedData,
    derived: evaluateDerived(prunedData, this.getConfig().derived, this.getContext()),
    input_section_states: sectionStates,
    edge_states: evaluateEdgeStates(prunedData, this.getConfig(), this.getContext(), sectionStates)
  };
};

function orderPreconditions(config) {
  const { nodes, edges } = config;
  const deps = [];
  // collect node preconditions '$' ref dependencies
  traverse(nodes).forEach(function (node) {
    if (node && node.preconditions) {
      const dependantPath = node.path;
      traverse(node.preconditions).forEach(function (preconNode) {
        if (isRefString (preconNode)) {
          deps.push([dependantPath, preconNode]);
        }
      });
    }
  });
  return toposort(deps).reverse();
}

function isRefString(val) {
  if (typeof val !== 'string') {
    return false;
  }
  return val.indexOf('$.') === 0;
}

function pruneData(data, config, depOrder, context) {
  const result = cloneDeep(data);
  depOrder.forEach(function (dep) {
    const paths = getDataPathsForRefPath(dep, data);
    paths.forEach(function (path) {
      if (!preconditionsMet(config.getConfigNodeByPath(dep), data, context, path)) {
        // remove data at path
        set(result, path, undefined);
      }
    });
  });
  return result;
}

function preconditionsMet(configNode, data, context, dataPath) {
  const preconditions = configNode.preconditions;
  if (!preconditions || !Array.isArray(preconditions)) {
    // no preconditions, so 'met' by default
    return true;
  }
  return preconditions.reduce((memo, precondition) => {
    return memo && resolve(precondition, data, context, dataPath);
  }, true);
}

function evaluateDerived(data, derivedConfigNode = [], context) {
  return derivedConfigNode.reduce((memo, derived) => {
    memo[derived.id] = resolve(derived, data, context, null);
    return memo;
  }, {});
}

function evaluateSectionStates(data = {}, config = {}, context = {}) {
  const { nodes } = config;
  const result = {};
  nodes.forEach(node => {
    const sectionId = node.id;
    const validationMessages = [];
    traverse(node).forEach(function (n) {
      // requiredValidations
      // cases:
      //  1. static ref - must be present if node's preconditions met
      //  2. ref is descendant of array (*) - collect all data nodes at descendant ref and apply
      if (n && n.required) {
        if (!isArrayPath(n.path)) {
          // static path, e.g. $.personal_details.name.title
          const dataPath = n.path.replace('$.', '');
          // console.log('validating static path', dataPath);
          applyRequiredValidationIfMissing(n, data, context, dataPath, validationMessages);
        } else {
          let pathHead = n.path.split('.');
          pathHead.pop();
          pathHead = pathHead.join('.');
          if (!isArrayPath(pathHead)) {
            applyRequiredValidationIfMissing(n, data, context, pathHead.replace('$.', ''), validationMessages);
          } else {
            // array descendant
            const ancestorRefPath = getNearestRepeatableAncestorRefPath(pathHead);
            const dataPaths = getDataPathsForRefPath(ancestorRefPath, data);
            // console.log(n.path, ' ancestor:', ancestorRefPath);
            // console.log('dataPaths:', dataPaths);
            dataPaths.forEach(dataPath => {
              const dataPathString = dataPath.join('.')
              const absoluteDataPath = getAbsoluteDataPath(dataPathString, n.path);
              applyRequiredValidationIfMissing(n, data, context, absoluteDataPath, validationMessages);
            });
          }
        }
      }
    });
    // custom validation checks:
    // for each value in data tree, get associated config node
    // and determine validation message (preconditions met and first validation failure).
    // Add to validationMessages if target path is undefined;
    traverse(data[sectionId]).forEach(function(dataNode) {
      const absolutePath = [sectionId].concat(this.path);
      if (this.isLeaf) {
        const configNode = config
          .getConfigNodeByPath(
            getRefPathForDataPath(absolutePath)
          );
        applyCustomValidationIfFails(configNode, data, context, absolutePath, validationMessages);
      }
    });
    result[sectionId] = {
      status: validationMessages.length ? 'invalid' : 'valid',
      validationMessages
    };
  });
  return result;
}

function evaluateEdgeStates(data = {}, config = {}, context = {}, sectionStates) {
  const { edges } = config;
  const nodeEvaluationOrder = getNodeEvaluationOrder(edges);
  let frontierFound = false;
  const nodeStatuses = nodeEvaluationOrder.reduce((memo, nodePath) => {
    if (isTerminalNodePath(nodePath)) {
      memo[nodePath] = 'active';
      return memo;
    }
    const node = config.getConfigNodeByPath('$.' + nodePath);
    if (frontierFound) {
      memo[nodePath] = 'inactive';
      return memo;
    }
    if (node.type === 'input_section') {
      if (sectionStates[node.id.replace('$.', '')].status === 'valid') {
        memo[nodePath] = 'active';
        return memo;
      } else {
        frontierFound = true;
        memo[nodePath] = 'inactive';
        return memo;
      }
    }
    if (node.type === 'decision') {
      memo[nodePath] = resolve(node.output, data, context, null);
      return memo;
    }
  }, {});

  return edges.map(edge => {
    let status = nodeStatuses[edge.from];
    const fromNode = (config.getConfigNodeByPath('$.' + edge.from) || {});
    // handle edges from decision nodes
    if (fromNode.type === 'decision' && status !== 'inactive') {
      status = (status ?
        (edge.when_input_is ? 'active' : 'inactive') :
        (edge.when_input_is ? 'inactive': 'active')
      );
    }
    return Object.assign({}, edge, {
      status
    });
  });
}

function isTerminalNodePath(path) {
  return path === 'START' || path === 'END';
}

function getNodeEvaluationOrder(edges = []) {
  const dependencies = [['END', 'START']]; // END depends on START
  edges.forEach(edge => {
    dependencies.push([edge.to, edge.from]);
  });
  return toposort(dependencies).reverse();
}

function applyRequiredValidationIfMissing(configNode, data, context, path, messageArr) {
  const validationMessage = validateRequired(configNode, data, context, path);
  if (validationMessage) {
    // console.log('adding validation message:', validationMessage);
    messageArr.push(validationMessage);
  }
}

function validateRequired(configNode, data, context, path) {
  const requiredMessage = resolveRequiredMessage(configNode.required, data, context, path);
  // console.log('\n\npath:', path);
  // console.log('requiredMessage:', requiredMessage);
  // console.log('preconditionsMet:', preconditionsMet(configNode, data, context, path));
  // console.log('dataNodeIsBlank:', dataNodeIsBlank(path, data));
  if (  requiredMessage
        && preconditionsMet(configNode, data, context, path)
        && dataNodeIsBlank(path, data)
     ) {
    // console.log('required message for ', path, requiredMessage);
    return {
      path,
      message: requiredMessage
    };
  }
  return null; // valid
}

function applyCustomValidationIfFails(configNode, data, context, path, messageArr) {
  const validationMessage = validateCustom(configNode, data, context, path);
  if (validationMessage && !find(messageArr, {path: path.join('.')})) {
    // console.log('adding validation message:', validationMessage);
    messageArr.push(validationMessage);
  }
}

function validateCustom(configNode={}, data, context, path) {
  const validations = configNode.validations;
  if (!validations) {
    return null;
  }
  if (  preconditionsMet(configNode, data, context, path)
        && !isBlank(get(data, path))) {
    for (let i = 0; i < validations.length; i += 1) {
      const validation = validations[i];
      if (resolve(validation, data, context, path) === false) {
        return {
          path: path.join('.'),
          message: validation.message
        };
      }
    }
  }
  return null; // valid
}

function isArrayPath(path) {
  return path.indexOf('*') > -1;
}

function getNearestRepeatableAncestorRefPath(path) {
  let pathArr = path.split('.');
  let item;
  while (item = pathArr.pop()) {
    if (item === '*') {
      return pathArr.join('.').concat('.*');
    }
  }
  return null;
}

function getAbsoluteDataPath(rootDataPath, refPath) {
  // crude implementation that doesn't ensure each level is a match
  const dataArr = rootDataPath.split('.');
  const refArr = refPath.replace('$.', '').split('.');
  for (let i = dataArr.length; i < refArr.length; i++) {
    dataArr.push(refArr[i]);
  }
  return dataArr.join('.');
}

function dataNodeIsBlank(path, data) {
  const value = get(data, path);
  // console.log('dataNode value:', value);
  if (value === undefined || value === '') {
    return true;
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || isBlank(value[0])) {
      return true;
    }
  }
  return false;
}

function isBlank(value) {
  return value === undefined || value === '';
}

function resolveRequiredMessage(requiredNode, data, context, path) {
  let resolvedRequired = resolve(requiredNode, data, context, this.path);
  if (Array.isArray(resolvedRequired)) {
    resolvedRequired = resolvedRequired.reduce((memo, result, index) => {
      if (result && !memo) {
        memo = requiredNode[index].message
      }
      return memo;
    }, false);
  }
  return resolvedRequired;
}

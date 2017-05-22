var _ = require('lodash');
var os = require('os');
var falafel = require('falafel');
var acorn = require('acorn-jsx');
const beautify = require('js-beautify').js_beautify;

let components;

module.exports = convert;

/**
 * Converts some code from AMD to ES6
 * @param {string} source
 * @param {object} [options]
 * @returns {string}
 */
function convert (source, options) {
    // initialize components
    components = [];
    options = options || {};

    var dependenciesMap = {};
    var syncRequires = [];
    var requiresWithSideEffects = [];
    var mainCallExpression = null;
    let componentDefinition;
    let factoryNode;
    let registerNode;
    let serviceRegisterNode;
    let mainRegisterModulesNode;

    // update copyright
    const myCopyright = /(?:©|\(c\)|copyright\b)\s*(\d{4})(?:-(\d{4}))?/;
    const copyrightMatch = source.match(myCopyright);
    if(copyrightMatch) {
      const currentYear = new Date().getFullYear();
      let newCopyright = '(c) ' + copyrightMatch[1];
      if(copyrightMatch[1] < currentYear) {
        newCopyright += '-' + currentYear;
      }
      source = source.replace(copyrightMatch[0], newCopyright);
    }

    var result = falafel(source, {
        parser: acorn,
        plugins: {jsx: true},
        ecmaVersion: 6
    }, function (node) {
        // console.log(node);
        if(node.type === 'Identifier' && node.name === 'module' &&
          node.parent.type === 'CallExpression' &&
          node.parent.callee.name === 'register' &&
          node.parent.parent.parent.parent.parent.type === 'CallExpression' &&
          node.parent.parent.parent.parent.parent.callee.property.name
          === 'forEach') {
          mainRegisterModulesNode =
            node.parent.parent.parent.parent.parent.parent;
        }
        if(node.type === 'ObjectExpression' &&
          node.parent.type === 'CallExpression' && node.parent.callee.object &&
          node.parent.callee.object.name === 'module') {
          // capture source of component definition
          componentDefinition = 'export default ' + node.source() + ';';
        }
        // record the `register` function node
        if(node.name === 'register' &&
          node.parent.type === 'FunctionDeclaration') {
          const ns = node.parent.source();
          if(ns.includes('module.service') || ns.includes('module.directive')) {
            serviceRegisterNode = node.parent;
          } else {
            registerNode = node.parent;
          }
        }
        if(node.name === 'factory' &&
          node.type === 'Identifier' &&
          node.parent.type === 'FunctionDeclaration') {
          factoryNode = node.parent;
        }
        if(node.type === 'Literal' && node.parent.type === 'CallExpression' &&
          node.parent.callee.object &&
          node.parent.callee.object.name === 'requirejs') {
          node.parent.update(node.raw);
        }
        if(node.type === 'Identifier' &&
          node.parent.type === 'CallExpression' &&
          node.parent.callee.object &&
          node.parent.callee.object.name === 'module') {
          const componentName = camelCase(node.name);
          const componentType = node.parent.source().match(/module\.(.*)\(/)[1];
          node.parent.parent.update('module.' + componentType + '(\'br' +
            componentName + '\', ' + componentName + ');');
        }

        if (isNamedDefine(node)) {
            throw new Error('Found a named define - this is not supported.');
        }

        if (isDefineUsingIdentifier(node)) {
            throw new Error('Found a define using a variable as the callback - this is not supported.');
        }

        if (isModuleDefinition(node)) {

            if (mainCallExpression) {
                throw new Error('Found multiple module definitions in one file.');
            }

            mainCallExpression = node;
        }

        else if (isSyncRequire(node)) {
            syncRequires.push(node);
        }

        else if (isRequireWithNoCallback(node)) {
            requiresWithSideEffects.push(node);
        }

        else if (isRequireWithDynamicModuleName(node)) {
            throw new Error('Dynamic module names are not supported.');
        }

        if (isUseStrict(node)) {
          node.parent.update('');
        }

    });

    // no module definition found - return source untouched
    if (!mainCallExpression) {
        return source;
    }

    var moduleDeps = mainCallExpression.arguments.length > 1 ? mainCallExpression.arguments[0] : null;
    var moduleFunc = mainCallExpression.arguments[mainCallExpression.arguments.length > 1 ? 1 : 0];
    var hasDeps = moduleDeps && moduleDeps.elements.length > 0;

    if (hasDeps) {

        var modulePaths = moduleDeps.elements.map(function (node) {
            return node.raw;
        });

        var importNames = moduleFunc.params.map(function (param) {
            return param.name;
        });

        extend(dependenciesMap, modulePaths.reduce(function (obj, path, index) {
            if(importNames[index] &&
              importNames[index].match(/Directive|Component|Filter|Service/)) {
                obj[path] = camelCase(importNames[index]);
            } else {
              obj[path] = importNames[index] || null;
            }
            return obj;
        }, {}));
    }

    syncRequires.forEach(function (node) {
        var moduleName = node.arguments[0].raw;

        // if no import name assigned then create one
        if (!dependenciesMap[moduleName]) {
            dependenciesMap[moduleName] = makeImportName(node.arguments[0].value);
        }

        // replace with the import name
        node.update(dependenciesMap[moduleName]);
    });

    requiresWithSideEffects.forEach(function (node) {

        // get the module names
        var moduleNames = node.arguments[0].elements.map(function (node) {
            return node.value;
        });

        // make sure these modules are imported
        moduleNames.forEach(function (moduleName) {
            if (!dependenciesMap.hasOwnProperty(moduleName)) {
                dependenciesMap[moduleName] = null;
            }
        });

        // remove node
        node.parent.update('');
    });

    // start with import statements
    var moduleCode = getImportStatements(dependenciesMap);

    if(mainRegisterModulesNode) {
      let moduleRegistration = '';
      components.forEach(comp => {
        const c = comp.toLowerCase();
        let type;
        ['component', 'directive', 'service', 'filter'].forEach(t => {
          if(c.includes(t)) {
            type = t;
          }
        });
        if(!type) {
          throw new Error('Unknown component type!');
        }
        moduleRegistration +=
          'module.' + type + '(\'br' + comp + '\', ' + comp + ');\n';
      });
      mainRegisterModulesNode.update(moduleRegistration);
    }
    // replace register fuction
    if(registerNode) {
      registerNode.update(componentDefinition);
    }
    if(serviceRegisterNode) {
      serviceRegisterNode.update('');
    }
    if(factoryNode) {
      factoryNode.update(factoryNode.source()
        .replace(/^function/, 'export default function'));
    }

    // add modules code
    moduleCode += getModuleCode(moduleFunc);

    // fix indentation
    if (options.beautify) {
        const opts = {
          end_with_newline: false,
          indent_size: 2,
          max_preserve_newlines: 2,
          space_before_conditional: false,
          wrap_line_length: 80,
          brace_style: 'collapse, preserve-inline'
        };
        moduleCode = beautify(moduleCode, opts);
    }

    // update the node with the new es6 code
    mainCallExpression.parent.update(moduleCode);

    return result.toString();
}

function camelCase(text) {
  return _.chain(text).camelCase().upperFirst().value();
}

/**
 * Takes an object where the keys are module paths and the values are
 * the import names and returns the import statements as a string.
 * @param {object} dependencies
 * @returns {string}
 */
function getImportStatements (dependencies) {
    var statements = [];

    for (var key in dependencies) {

        // if (!dependencies[key]) {
        //     statements.push('import ' + key + ';');
        // }
        // always create import name
        if (!dependencies[key]) {
            const componentName = camelCase(key);
            components.push(componentName);
            statements.push('import ' + componentName + ' from ' + key + ';');
        }
        else {
            statements.push('import ' + dependencies[key] +
            ' from ' + key + ';');
        }
    }

    return statements.join(os.EOL);
}

/**
 * Updates the return statement of a FunctionExpression to be an 'export default'.
 * @param {object} functionExpression
 */
function updateReturnStatement (functionExpression) {
    functionExpression.body.body.forEach(function (node) {
        if (node.type === 'ReturnStatement') {
            // node.update(node.source().replace('return ', 'export default '));
            node.update('');
        }
    });
}

/**
 *
 * @param {object} moduleFuncNode
 * @returns {string}
 */
function getModuleCode (moduleFuncNode) {

    updateReturnStatement(moduleFuncNode);

    var moduleCode = moduleFuncNode.body.source();

    // strip '{' and '}' from beginning and end
    moduleCode = moduleCode.substring(1);
    moduleCode = moduleCode.substring(0, moduleCode.length - 1);

    return moduleCode;
}

/**
 * Takes a CallExpression node and returns a array that contains the types of each argument.
 * @param {object} callExpression
 * @returns {array}
 */
function getArgumentsTypes (callExpression) {
    return callExpression.arguments.map(function (arg) {
        return arg.type;
    });
}

/**
 * Returns true if the node is a require() or define() CallExpression.
 * @param {object} node
 * @returns {boolean}
 */
function isRequireOrDefine (node) {
    return isRequire(node) || isDefine(node);
}

/**
 * Returns true if this node represents a require() call.
 * @param {object} node
 * @returns {boolean}
 */
function isRequire (node) {
    return node.type === 'CallExpression' && node.callee.name === 'require';
}

/**
 * Returns true if this node represents a define() call.
 * @param {object} node
 * @returns {boolean}
 */
function isDefine (node) {
    return node.type === 'CallExpression' && node.callee.name === 'define';
}

/**
 * Returns true if arr1 is the same as arr2.
 * @param {array} arr1
 * @param {array} arr2
 * @returns {boolean}
 */
function arrayEquals (arr1, arr2) {

    if (arr1.length !== arr2.length) {
        return false;
    }

    for (var i = 0; i < arr1.length; i++) {
        if (arr1[i] !== arr2[i]) {
            return false;
        }
    }

    return true;
}

/**
 * Returns true if node is a require() call where the module name is a literal.
 * @param {object} node
 * @returns {boolean}
 */
function isSyncRequire (node) {
    return isRequire(node) &&
           arrayEquals(getArgumentsTypes(node), ['Literal']);
}

/**
 * Returns true if node is a require() call where the module name is not a literal.
 * @param {object} node
 * @returns {boolean}
 */
function isRequireWithDynamicModuleName(node) {
    if (!isRequire(node)) {
        return false;
    }
    var argTypes = getArgumentsTypes(node);
    return argTypes.length === 1 && argTypes[argTypes.length - 1] !== 'Identifier';
}

/**
 * Adds all properties in source to target.
 * @param {object} target
 * @param {object} source
 */
function extend (target, source) {
    for (var key in source) {
        target[key] = source[key];
    }
}

/**
 * Returns true if this node represents a module definition using either a require or define.
 * @param {object} node
 * @returns {boolean}
 */
function isModuleDefinition (node) {

    if (!isRequireOrDefine(node)) {
        return false;
    }

    var argTypes = getArgumentsTypes(node);

    // eg. require(['a', 'b'])
    if (arrayEquals(argTypes, ['ArrayExpression'])) {
        return true;
    }

    // eg. require(['a', 'b'], function () {})
    if (arrayEquals(argTypes, ['ArrayExpression', 'FunctionExpression'])) {
        return true;
    }

    // eg. require(function () {}) or define(function () {})
    if (arrayEquals(argTypes, ['FunctionExpression'])) {
        return true;
    }
}

/**
 * Returns true if this node represents a call like require(['a', 'b']);
 * @param {object} node
 * @returns {boolean}
 */
function isRequireWithNoCallback (node) {
    return isRequire(node) && arrayEquals(getArgumentsTypes(node), ['ArrayExpression']);
}

/**
 * Returns true if node represents a named define eg. define('my-module', function () {})
 * @param {object} node
 * @returns {boolean}
 */
function isNamedDefine (node) {
    return isDefine(node) && getArgumentsTypes(node)[0] === 'Literal';
}

/**
 * Returns true if node represents a define call where the callback is an identifier eg. define(factoryFn);
 * @param {object} node
 * @returns {boolean}
 */
function isDefineUsingIdentifier(node) {
    if (!isDefine(node)) {
        return false;
    }
    var argTypes = getArgumentsTypes(node);
    return argTypes[argTypes.length - 1] === 'Identifier';
}

/**
 * Makes a new import name derived from the name of the module path.
 * @param {string} moduleName
 * @returns {string}
 */
function makeImportName (moduleName) {
    return '$__' + moduleName.replace(/[^a-zA-Z]/g, '_');
}

/**
 * Returns true if node represents a 'use strict'-statement
 * @param {object} node
 * @returns {boolean}
 */
function isUseStrict (node) {
    return node.type === 'Literal' && node.value === 'use strict';
}

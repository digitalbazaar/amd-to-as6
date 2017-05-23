var falafel = require('falafel');
var acorn = require('acorn-jsx');

module.exports = convert;

/**
 * Converts some code from AMD to ES6
 * @param {string} source
 * @param {object} [options]
 * @returns {string}
 */
function convert(source, options) {
  // initialize components
  let changed = false;

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
    changed = true;
  }

  var result = falafel(source, {
    parser: acorn,
    plugins: {jsx: true},
    ecmaVersion: 6,
    sourceType: 'module'
  }, function(node) {
    // console.log(node);
    if(node.type === 'ImportDefaultSpecifier') {
      const importStatement = node.parent.source();
      if(isBedrockComponent(importStatement)) {
        changed = true;
        node.parent.update(importStatement.substring(0, importStatement
          .lastIndexOf('\'')) + '.js\';');
      }
    }
  });

  // return unchanged
  if(!changed) {
    return source;
  }

  // update the node with the new es6 code
  // mainCallExpression.parent.update(moduleCode);

  return result.toString();
}

function isBedrockComponent(importStatement) {
  return ['-directive', '-component', '-service', '-filter', '-controller']
    .some(t => importStatement.toLowerCase().includes(t));
}

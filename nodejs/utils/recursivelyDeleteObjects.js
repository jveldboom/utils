/**
 * Recursively deletes properties from an object that match a specified regular expression
 * @param {Object} obj input object
 * @param {RegExp} removeRegex regular expression used to match properties for removal
 * @returns {Object} modified object after the removal of matching properties.
 */
const recursivelyDeleteObjects = (obj, removeRegex) => {
  for (const property in obj) {
    if (!obj.hasOwnProperty(property)) continue

    if (removeRegex.test(property)) delete obj[property]
    else if (typeof obj[property] === 'object') recursivelyDeleteObjects(obj[property], removeRegex)
  }
  return obj
}

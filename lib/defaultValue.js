const defined = require("./defined");

/**
 * 获取默认值
 * @param {any} value
 * @param {any} defaultValue
 * @returns {any}
*/
function defaultValue(value, defaultValue) {
    return defined(value) ? value : defaultValue;
};

defaultValue.EMPTY_OBJECT = Object.freeze({});

module.exports = defaultValue;
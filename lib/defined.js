/**
 * 判断值是否定义
 * @param {any} value 
 * @returns {boolean}
 */
function defined(value) {
    return value !== undefined && value !== null;
};

module.exports = defined;
module.exports = function parentPath(x) {
  var match = String(x).match(/((\/[\w_-]+)+)\/[\w_-]+$/);
  return match ? match[1] : '/';
};

(function () { "use strict";

var util = require('util');
var events = require('events');

function DBSubsystemBase () {
	this.db = null;
}
util.inherits(DBSubsystemBase, events.EventEmitter);

DBSubsystemBase.prototype.dbevent = function(name, data, access) {
	this.emit('dbevent', {name:name, data:data, access:access});
}

exports.DBSubsystemBase = DBSubsystemBase;

})();

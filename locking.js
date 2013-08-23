(function () { "use strict";

var util = require('util');
var events = require('events');
var _ = require('underscore');

function Lock() {
	this.locksHeld = {};
}
util.inherits(Lock, events.EventEmitter);

Lock.prototype.locked = function(locks, origCB, fn) {
	var isLocked = false;
	for (var i = 0; i < locks.length; ++i) {
		if (_.has(this.locksHeld, 'lock-' + locks[i])) {
			isLocked = true;
			break;
		}
	} 
	
	if (isLocked)
		return this.once('release', _.bind(function() { this.locked(locks, origCB, fn); }, this));
	
	for (var i = 0; i < locks.length; ++i) {
		this.locksHeld['lock-' + locks[i]] = true;
		this.emit('lock', locks[i]);
	}
	
	var newCB = _.bind(function() {
		for (var i = 0; i < locks.length; ++i) {
			delete this.locksHeld['lock-' + locks[i]];
			this.emit('release', locks[i]);
		}
		
		if (origCB)
			origCB.apply(this, arguments);
	}, this);
	
	fn(newCB);
}

Lock.globalLockAuthority = new Lock();

exports.Lock = Lock;

})();

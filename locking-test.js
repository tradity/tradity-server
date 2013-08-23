(function () { "use strict";

var locking = require('./locking.js');
var _ = require('underscore');

var lock = locking.Lock.globalLockAuthority;

lock.on('lock', _.bind(console.log, console, 'lock'));
lock.on('release', _.bind(console.log, console, 'release'));

lock.locked(['testlock1'], null, function(cb1) {
	lock.locked(['testlock2'], cb1, function(cb2) {
		lock.locked(['testlock1'], null, function(cb3) {
			cb3();
		});
		_.defer(cb2);
	});
});

})();

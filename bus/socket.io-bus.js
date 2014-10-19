(function () { "use strict";

var Adapter = require('socket.io-adapter');
var _ = require('underscore');
var util = require('util');

/**
 * Returns a socket.io Adapter for use with a Bus
 */
function busAdapter(bus, prefix) {
	prefix = prefix || 'socket.io';

	function BusAdapter(namespace) {
		Adapter.call(this, namespace);
		bus.on(prefix + '::' + namespace, _.bind(this.incoming, this));
	}
	
	util.inherits(BusAdapter, Adapter);
	
	BusAdapter.prototype.incoming = function(p) {
		this.broadcast(p.packet, p.opts, true);
	};

	BusAdapter.prototype.broadcast = function(packet, opts, remote) {
		console.log('broadcasting', packet, opts);
		Adapter.prototype.broadcast.call(this, packet, opts);
		if (!remote)
			bus.emit(prefix + '::' + namespace, {packet: packet, opts: opts});
	};

	return BusAdapter;
}

exports.busAdapter = busAdapter;

})();

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
		bus.on(prefix + '::' + this.nsp.name, _.bind(this.incoming, this));
	}
	
	util.inherits(BusAdapter, Adapter);
	
	BusAdapter.prototype.incoming = function(p) {
		this.broadcast_(p.packet, p.opts, true);
	};

	BusAdapter.prototype.broadcast = function(packet, opts) {
		this.broadcast_(packet, opts, false);
	};
	
	BusAdapter.prototype.broadcast_ = function(packet, opts, remote) {
		Adapter.prototype.broadcast.call(this, packet, opts);
		if (!remote)
			bus.emit(prefix + '::' + this.nsp.name, {packet: packet, opts: opts});
	};

	return BusAdapter;
}

exports.busAdapter = busAdapter;

})();

(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var templates = require('./templates-compiled.js');

function TemplateLoaderDB () {
	TemplateLoaderDB.super_.apply(this, arguments);
};

util.inherits(TemplateLoaderDB, buscomponent.BusComponent);

TemplateLoaderDB.prototype.readTemplate = buscomponent.provide('readTemplate', ['template', 'variables', 'reply'], function(template, variables, cb) {
	var t = templates[template];
	
	if (!t) {
		this.emitError(new Error('Template not found: ' + template));
		return null;
	}
	
	_.chain(variables).keys().each(function(e) {
		var r = new RegExp('\\$\\{' + e + '\\}', 'g');
		t = t.replace(r, variables[e]);
	});
	
	var unresolved = t.match(/\$\{([^\}]*)\}/);
	if (unresolved) {
		this.emitError(new Error('Unknown variable “' + unresolved[1] + '” in template ' + template));
		return null;
	}
	
	return cb(t);
});

TemplateLoaderDB.prototype.readEMailTemplate = buscomponent.provide('readEMailTemplate', ['template', 'variables', 'reply'], function(template, variables, cb) {
	this.readTemplate(template, variables, function(t) {
		var headerend = t.indexOf('\n\n');
		
		var headers = t.substr(0, headerend).split('\n');
		var body = t.substr(headerend + 2);
		
		var opt = {headers:{}};
		
		for (var i = 0; i < headers.length; ++i) {
			var h = headers[i];
			var headerNameEnd = h.indexOf(':');
			var headerName = h.substr(0, headerNameEnd).trim();
			var headerValue = h.substr(headerNameEnd + 1).trim();
			
			var camelCaseHeaderName = headerName.toLowerCase().replace(/-\w/g, function(w) { return w.toUpperCase(); }).replace(/-/g, '');
			
			if (['subject', 'from', 'to'].indexOf(camelCaseHeaderName) != -1)
				opt[camelCaseHeaderName] = headerValue;
			else
				opt.headers[headerName] = headerValue;
		}
		
		opt.html = body;
		opt.generateTextFromHTML = true;
		return cb(opt);
	});
});

exports.TemplateLoaderDB = TemplateLoaderDB;

})();


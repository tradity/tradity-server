(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var templates = require('./templates-compiled.js');

/**
 * Provides methods for reading in template files.
 * 
 * @public
 * @module template-loader
 */

/**
 * Main object of the {@link module:template-loader} module
 * 
 * @public
 * @constructor module:template-loader~TemplateLoader
 * @augments module:stbuscomponent~STBusComponent
 */
function TemplateLoader () {
	TemplateLoader.super_.apply(this, arguments);
};

util.inherits(TemplateLoader, buscomponent.BusComponent);

/**
 * Read a template and optionally substitute variables.
 * The strings which are substituted are of the format
 * <code>${varname}</code>.
 * 
 * @param {string} template  The file name of the remplate to read in.
 * @param {?object} variables  An dictionary of variables to replace.
 * 
 * @return {string} Calls the reply callback with the template, variables
 *                  having been substituted.
 * 
 * @function busreq~readTemplate
 */
TemplateLoader.prototype.readTemplate = buscomponent.provide('readTemplate',
	['template', 'variables', 'reply'],
	function(template, variables, cb) 
{
	variables = variables || {};
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

/**
 * Read an e-mail template and optionally substitute variables.
 * This internally calls {@link busreq~readTemplate} and has the same 
 * parameters, but header fields will be passend and an object suitable
 * for passing to {@link busreq~sendMail} is returned rather than a string.
 * 
 * @param {string} template  The file name of the remplate to read in.
 * @param {?object} variables  An dictionary of variables to replace.
 * 
 * @function busreq~readEMailTemplate
 */
TemplateLoader.prototype.readEMailTemplate = buscomponent.provide('readEMailTemplate', ['template', 'variables', 'reply'], function(template, variables, cb) {
	return this.readTemplate(template, variables, function(t) {
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

exports.TemplateLoader = TemplateLoader;

})();


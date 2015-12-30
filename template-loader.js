"use strict";

const _ = require('lodash');
const util = require('util');
const assert = require('assert');
const buscomponent = require('./stbuscomponent.js');
const templates = require('./templates-compiled.js');
const debug = require('debug')('sotrade:template-loader');

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
class TemplateLoader extends buscomponent.BusComponent {
  constructor() {
    super();
  }
}

/**
 * Read a template and optionally substitute variables.
 * The strings which are substituted are of the format
 * <code>${varname}</code>.
 * 
 * @param {string} template  The file name of the remplate to read in.
 * @param {string} lang  The preferred language for the files to be read in.
 * @param {?object} variables  An dictionary of variables to replace.
 * 
 * @return {string} Returns the template, variables having been substituted.
 * 
 * @function busreq~readTemplate
 */
TemplateLoader.prototype.readTemplate = buscomponent.provide('readTemplate',
  ['template', 'lang', 'variables'],
  function(template, lang, variables)
{ 
  debug('Read template', template, lang, variables);
  
  return this.getServerConfig().then(cfg => {
    variables = variables || {};
    
    let t = templates[lang] && templates[lang][template];
    
    for (let i = 0; !t && i < cfg.languages.length; ++i)
      t = templates[cfg.languages[i].id][template];
    
    if (!t)
      throw new Error('Template not found: ' + template);
    
    Object.keys(variables).forEach(e => {
      const r = new RegExp('\\$\\{' + e + '\\}', 'g');
      t = t.replace(r, variables[e]);
    });
    
    const unresolved = t.match(/\$\{([^\}]*)\}/);
    if (unresolved)
      throw new Error('Unknown variable “' + unresolved[1] + '” in template ' + template);
    
    return t;
  });
});

/**
 * Read an e-mail template and optionally substitute variables.
 * This internally calls {@link busreq~readTemplate} and has the same 
 * parameters, but header fields will be passend and an object suitable
 * for passing to {@link busreq~sendMail} is returned rather than a string.
 * 
 * @param {string} template  The file name of the remplate to read in.
 * @param {string} lang  The preferred language for the files to be read in.
 * @param {?object} variables  An dictionary of variables to replace.
 * 
 * @function busreq~readEMailTemplate
 */
TemplateLoader.prototype.readEMailTemplate = buscomponent.provide('readEMailTemplate',
  ['template', 'lang', 'variables'], function(template, lang, variables) {
  return this.readTemplate(template, lang, variables).then(function(t) {
    const headerend = t.indexOf('\n\n');
    
    const headers = t.substr(0, headerend).split('\n');
    const body = t.substr(headerend + 2);
    
    const opt = {
      headers: {
        'X-SoTrade-Lang': lang
      }
    };
    
    for (let i = 0; i < headers.length; ++i) {
      const h = headers[i];
      const headerNameEnd = h.indexOf(':');
      const headerName = h.substr(0, headerNameEnd).trim();
      const headerValue = h.substr(headerNameEnd + 1).trim();
      
      const camelCaseHeaderName = headerName.toLowerCase().replace(/-\w/g, function(w) { return w.toUpperCase(); }).replace(/-/g, '');
      
      if (['subject', 'from', 'to'].indexOf(camelCaseHeaderName) != -1)
        opt[camelCaseHeaderName] = headerValue;
      else
        opt.headers[headerName] = headerValue;
    }
    
    opt.html = body;
    opt.generateTextFromHTML = true;
    return opt;
  });
});

exports.TemplateLoader = TemplateLoader;

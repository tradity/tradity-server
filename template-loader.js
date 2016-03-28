// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const path = require('path');
const fs = require('fs');
const api = require('./api.js');
const promiseUtil = require('./lib/promise-util.js');
const debug = require('debug')('sotrade:template-loader');

class TemplateReader extends api.Component {
  constructor() {
    super({
      identifier: 'TemplateReader',
      description: 'Read a template and optionally substitute variables.',
      notes: 'The strings which are substituted are of the format `${varname}`'
    });
    
    this.loadedTemplates = new Map();
  }
  
  loadRawTemplate(lang, template) {
    const key = lang + ':' + template;
    
    if (this.loadedTemplates.has(key)) {
      return Promise.resolve(this.loadedTemplates.get(key));
    }
    
    const filename = path.join(
      typeof __dirname !== 'undefined' ? __dirname : './',
      'templates',
      lang,
      template);
    
    return promiseUtil.bufferFromStream(fs.createReadStream(filename))
      .catch(e => {
        if (e.code === 'ENOENT') {
          return null;
        }
        
        throw e;
      }).then(data => {
        this.loadedTemplates.set(key, data);
        
        return data === null ? null : data.toString('utf-8');
      });
  }
  
  findRawTemplate(lang, template, cfg) {
    return this.loadRawTemplate(lang, template).then(content => {
      if (content) {
        return content;
      }
      
      return cfg.languages.reduce((prevContent, lang) => {
        if (prevContent) {
          return prevContent;
        }
        
        return this.loadRawTemplate(lang.id, template);
      }, null);
    });
  }
  
  readTemplate(template, lang, variables) { 
    debug('Read template', template, lang, variables);
    
    const cfg = this.load('Config').config();
    
    variables = variables || {};
    
    return this.findRawTemplate(lang, template, cfg).then(t => {
      if (!t) {
        throw new Error('Template not found: ' + template);
      }
      
      Object.keys(variables).forEach(e => {
        const r = new RegExp('\\$\\{' + e + '\\}', 'g');
        t = t.replace(r, variables[e]);
      });
      
      const unresolved = t.match(/\$\{([^\}]*)\}/);
      if (unresolved) {
        throw new Error('Unknown variable “' + unresolved[1] + '” in template ' + template);
      }
      
      return t;
    });
  }

  readEMailTemplate(template, lang, variables) {
    return this.readTemplate(template, lang, variables).then(t => {
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
        
        const camelCaseHeaderName = headerName.toLowerCase().replace(/-\w/g, w => w.toUpperCase()).replace(/-/g, '');
        
        if (['subject', 'from', 'to'].indexOf(camelCaseHeaderName) !== -1) {
          opt[camelCaseHeaderName] = headerValue;
        } else {
          opt.headers[headerName] = headerValue;
        }
      }
      
      opt.html = body;
      opt.generateTextFromHTML = true;
      return opt;
    });
  }
}

exports.components = [
  TemplateReader
];

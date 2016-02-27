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

const Cache = require('./lib/minicache.js').Cache;

class Component {
  constructor(options) {
    options = options || {};
    this.depends = options.depends || [];
    this._loadedDeps = new Map();
  }
  
  init(registry) {
    return Promise.all(this.depends.map(dependency => {
      return registry.load(dependency).then(result => {
        this._loadedDeps.set(dependency, result);
      });
    }));
  }
  
  postInit() {
  }
  
  load(dependency) {
    assert.ok(this.depends.indexOf(dependency) !== -1);
    
    return this._loadedDeps.get(dependency);
  }
}

class Registry extends Component {
  constructor() {
    super({identifier: '_Registry'});
    
    this._dependencyIndex = new Map();
    this._instances = [];
    this._inited = false;
  }
  
  addComponentClass(Cls) {
    if (this._inited) {
      throw new Error('Cannot add classes after init() was called');
    }
    
    if (this._dependencyIndex.has(Cls)) {
      throw new Error('Dependency already registered: ' + String(Cls));
    }
    
    const instance = new Cls();
    
    this._dependencyIndex.put(Cls, instance);
    
    if (instance.identifier) {
      this._dependencyIndex.put(instance.identifier, instance);
    }
    
    this._instances.push(instance);
  }
  
  init() {
    if (this._inited) {
      throw new Error('Registry.init() called twice');
    }
    
    this._inited = true;
    
    return Promise.all( this._instances.map(i => i.init()) ).then(() => 
           Promise.all( this._instances.map(i => i.postInit()) );
  }
  
  load(dependency) {
    const result = this._dependencyIndex.get(dependency);
    
    if (!result) {
      throw new Error('Dependency not found: ' + String(dependency));
    }
    
    return result;
  }
}

/**
 * Main object of the {@link module:api} module
 * @public
 * @constructor module:api~Requestable
 */
class Requestable extends Component {
  constructor(options) {
    super(options);
    
    this.options = Object.assign({}, {
      transactional: false,
      writing: false,
      methods: ['GET'],
      returns: [ { code: 200 } ],
      requiredAccess: null,
      requiredLogin: true,
      schema: null
    }, options);
    
    if (!this.options.url) {
      throw new TypeError('Requestable instances need url property');
    }
    
    if (!this.options.description) {
      throw new TypeError('Description is neccessary for Requestable instances');
    }
    
    if (this.options.transactional) {
      this.options.writing = true;
    }
    
    this.options.methods = this.options.methods.map(m => m.toUpperCase());
    
    if (this.options.writing && this.options.methods.indexOf('GET') !== -1) {
      throw new TypeError('Writing Requestable instances cannot use GET');
    }
    
    if (!this.options.writing && this.options.methods.indexOf('GET') === -1) {
      throw new TypeError('Non-writing Requestable instances must allow GET');
    }
    
    if (this.options.schema) {
      const s = this.options.schema;
      if (!s.$schema) {
        s.$schema = "http://json-schema.org/draft-04/schema#";
      }
      
      if (!s.title) {
        s.title = requestable.url + ' (' + this.options.methods.join(', ') + ')';
      }
    }
    
    this.cache = new Cache();
    
    const requestable = this;
    
    this.ClientError = 
    class ClientError extends Error {
      constructor(identifier) {
        const info = requestable.returns.filter(r => r.identifier === identifier);
        if (!info) {
          throw new TypeError('No identifier info available for ' + identifier);
        }
        
        Object.assign(this, info);
        
        super(requestable.url + ': ' + this.statusCode + ': ' + identifier);
      }
    };
  }
  
  // XXX: freeze query object
  // XXX: drop “school” from public API
  // XXX: cc__
  // XXX: server config (xdata)
  // XXX: getServerConfig
  // XXX: schema validation
  // XXX: .request
  // XXX: remove SoTradeClientError, PermissionDenied, FormatError
  // XXX: Markdown
  // XXX: other XXXes
  // XXX: /** */
  // XXX: Docs?
  // XXX: Publicize code-based documentation
  // XXX: Check for parseInt/parseFloat/isNan/etc.
  // XXX: special handling for 204s
  // XXX: Check data: wrappers
  
  handle() {
    ...
  }
  
  ...
}

exports.Registry = Registry;
exports.Component = Component;
exports.Requestable = Requestable;

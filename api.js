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
const promiseEvents = require('promise-events');

const registryInit = Symbol('registryInit');
const _registry = Symbol('_registry');

class _Component extends promiseEvents.EventEmitter {
  constructor(options) {
    options = options || {};
    this.depends = options.depends || [];
    this[_registry] = new Map();
  }
  
  [registryInit](registry) {
    this[_registry] = registry;
    return Promise.all(this.depends.map(dependency => {
      return registry.load(dependency);
    }));
  }
  
  init() {
  }
  
  load(dependency) {
    assert.ok(this.depends.indexOf(dependency) !== -1);
    
    return this[_registry].load(dependency);
  }
}

class Component extends _Component {
  constructor(options) {
    options = options || {};
    options.depends = (options.depends || []).concat(['PubSub', 'Config']);
    super(options);
  }
  
  publish(name, data) {
    this.load('PubSub').publish(name, data);
  }
  
  subscribe(name, handler) {
    this.load('PubSub').subscribe(name, handler);
  }
}

const addComponentInstance = Symbol('addComponentInstance');
class Registry extends _Component {
  constructor() {
    super({identifier: '_Registry'});
    
    this._dependencyIndex = new Map();
    this._instances = [];
    this._inited = false;
    
    this[addComponentInstance](this, Registry);
  }
  
  [registryInit]() {}
  
  addComponentClass(Cls) {
    if (this._inited) {
      throw new Error('Cannot add classes after init() was called');
    }
    
    if (this._dependencyIndex.has(Cls)) {
      throw new Error('Dependency already registered: ' + String(Cls));
    }
    
    const instance = new Cls();
    
    assert.strictEqual(instance.constructor, Cls);
    
    return this[addComponentInstance](instance);
  }
  
  [addComponentInstance](instance) {
    this._dependencyIndex.put(Cls, instance);
    this._dependencyIndex.put(instance.constructor, instance);
    
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
    
    return Promise.all( this._instances.map(i => i[registryInit]()) ).then(() => 
           Promise.all( this._instances.map(i => i.init()) );
  }
  
  load(dependency) {
    const result = this._dependencyIndex.get(dependency);
    
    if (!result) {
      throw new Error('Dependency not found: ' + String(dependency));
    }
    
    return result;
  }
}

class URLMatcher {
  constructor(path) {
    this.path = path;
    this.parameters = [];
    
    let i = 1;
    this.regexp = new RegExp('^' + path.replace(/\((\?:?)?/g, '(?:')
      .replace(/:([^/]+?)\b/g, (match, name) => {
      this.parameters[i++] = name;
      return '([^/]+)';
    }) + '$');
  }
  
  match(url) {
    const match = url.match(this.regexp);
    if (!match) {
      return null;
    }
    
    return Object.assign.apply(Object, [{}, match].concat(
      match.map((content, index) => ({ [this.parameters[index]]: content }))
    ));
  }
}

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
    
    this.urlMatcher = new URLMatcher(this.options.url);
    
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
        
        super(requestable.url + ': ' + info.code + ': ' + identifier);
        
        Object.assign(this, info);
      }
    };
    
    this.BadRequest =
    class BadRequest extends Error {
      constructor(underlying) {
        super('Bad Request: ' + String(underlying));
        
        this.code = 400;
        this.identifier = 'bad-request';
      }
    };
    
    this.MissingHandler =
    class MissingHandler extends Error {
      constructor() {
        super('Missing handler');
        
        this.code = 500;
        this.identifier = 'missing-handler';
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
  // XXX: console.warn for 204/200 mismatch
  // XXX: Check data: wrappers
  // XXX: access.has
  // XXX: validation for non-Requestable components?
  // XXX: there may be some .freeze() missing for the registry components?
  // XXX: check for old onBusConnect entries
  // XXX: check old buscomponent.listener entries
  // XXX: dependencies which have not been explicitly loaded into the registry
  // XXX: check for literal 'function' entries
  // XXX: check for .result(s)
  // XXX: schema forwarding/inclusion
  // XXX: readonly? can we handle that one better?
  // XXX: regexp check for code:\s*['"]
  // XXX: default identifier to class name
  
  // wrap this.handle() for some backwards compatibility
  handleWithRequestInfo(query, ctx, cfg, xdata) {
    return this.handle(query, ctx, cfg);
  }
  
  handle(query, ctx, cfg) {
    throw new this.MissingHandler();
  }
  
  _handleRequest(req, res, uriMatch) {
    // get the remote address asap since it is lost with early disconnects
    const remoteAddress = req.socket.remoteAddress;
    
    return Promise.resolve().then(() => {
      if (req.method === 'GET')
        return {};
      
      if (!req.headers['content-type'].match(/^application\/(x-)?json/i))
        return {};
      
      return new Promise((resolve, reject) => {
        const jsonStream = req.pipe(JSONStream.parse());
        
        jsonStream.on('data', resolve);
        
        jsonStream.on('error', e => {
          reject(new this.BadRequest(e));
        });
      }
    }).then(postData => {
      const query = Object.assign({}, uriMatch, postData);
      const ctx = new qctx.QContext({parentComponent: this});
      
      return this.handleWithRequestInfo(query, ctx, this.load('Config').config(), {
        remoteip: remoteAddress
      });
    }).catch(err => {
      if (typeof err.code === 'number') {
        return err;
      }
      
      throw err;
    }).then(answer => {
      res.writeHead(answer.code);
      if (answer.code === 204) {
        // If we say “no content”, we stick to it.
      } else {
        const outJSON = JSONStream.stringify('', '', '');
        
        return new Promise((resolve, reject) => {
          outJSON.on('end', resolve);
          outJSON.on('error', reject);
        });
        
        outJSON.pipe(res);
        outJSON.end(answer);
      }
    });
  }
  
  handleRequest(req, res, uriMatch) {
    return Promise.resolve().then(() => {
      return this._handleRequest(req, res, uriMatch);
    }).catch(e => {
      res.writeHead(500, {'Content-Type': 'text/plain;charset=utf-8'});
      res.write('Error: ' + e.toString() + '\n' + e.stack);
      this.publish('error', e);
    });
  }
  
  getURLMatcher() {
    return this.urlMatcher;
  }
}

exports.Registry = Registry;
exports.Component = Component;
exports.Requestable = Requestable;

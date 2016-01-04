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

const util = require('util');
const _ = require('lodash');

const bus = require('tradity-bus');

Object.assign(exports, bus);

/**
 * Provides Tradity-specific extensions to the general {@link module:buscomponent} module
 * @public
 * @module stbuscomponent
 */

/**
 * Main object of the {@link module:stbuscomponent} module
 * @public
 * @constructor module:stbuscomponent~STBusComponent
 * @augments module:buscomponent~BusComponent
 */
class STBusComponent extends bus.BusComponent {
  constructor() {
    super();
  }

  getServerConfig() {
    return this.request({name: 'getServerConfig'});
  }
}

function txwrap(tables, options, fn) {
  if (typeof fn === 'undefined') {
    fn = options;
    options = tables;
    tables = null;
  }
  
  if (typeof fn === 'undefined') {
    fn = options;
    options = null;
  }
  
  return function() {
    // fn(query, ctx[, xdata, …])
    let ctx = arguments[1];
    ctx = ctx.clone().enterTransactionOnQuery(tables, options);
    arguments[1] = ctx;
    
    return ctx.txwrap(fn).apply(this, arguments);
  };
}

const provide = bus.provide;

function provideW(name, args, fn) {
  fn.needsWriting = true;
  
  return provide(name, args, fn, data => {
    if (data.ctx && data.ctx.getProperty('readonly')) {
      return { result: { code: 'server-readonly' }, prefiltered: true };
    }
    
    return { prefiltered: false };
  });
}

function provideQT(name, fn) { return provide(name, ['query', 'ctx', 'xdata'], fn); }
function provideWQT(name, fn) { return provideW(name, ['query', 'ctx', 'xdata'], fn); }
function provideTXQT(name, tables, options, fn) { return provideWQT(name, txwrap(tables, options, fn)); }

exports.provideW    = provideW;
exports.provideQT   = provideQT;
exports.provideWQT  = provideWQT;
exports.provideTXQT = provideTXQT;

// inheriting from Error is pretty ugly
function SoTradeClientError(code, msg) {
  const tmp = Error.call(this, code);
  tmp.name = this.name = 'SoTradeClientError';
  this.message = msg || tmp.message;
  this.code = code;
  this.stack = tmp.stack;
  this.isSotradeError = true;
  
  return this;
}

const IntermediateInheritor = function() {};
IntermediateInheritor.prototype = Error.prototype;
SoTradeClientError.prototype = new IntermediateInheritor();

SoTradeClientError.prototype.toJSON = function() {
  return _.pick(this, 'name', 'message', 'code');
};

STBusComponent.prototype.SoTradeClientError = SoTradeClientError;

function PermissionDenied (msg) {
  PermissionDenied.super_.call(this, 'permission-denied', msg);
}

util.inherits(PermissionDenied, SoTradeClientError);
STBusComponent.prototype.PermissionDenied = PermissionDenied;

function FormatError(msg) {
  FormatError.super_.call(this, 'format-error', msg);
}

util.inherits(FormatError, SoTradeClientError);
STBusComponent.prototype.FormatError = FormatError;

exports.BusComponent = STBusComponent;

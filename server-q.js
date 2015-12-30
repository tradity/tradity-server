#!/usr/bin/env node
"use strict";

Error.stackTraceLimit = Infinity;

const fs = require('fs');
const https = require('https');
const assert = require('assert');
const util = require('util');
const _ = require('lodash');

const cfg = require('./config.js').config();
const sotradeClient = require('./sotrade-client.js');

const options = process.argv.splice(2);

assert.ok(options.length > 0);

const query = {
  type: options[0],
  id: 'server-q-query'
};

for (let i = 1; i < options.length; ++i) {
  const p = options[i].match(/^-{0,2}([\w_-]+)=(.*)$/);
  
  let value = p[2];
  if (value == 'false') value = false;
  if (value == 'true')  value = true;
  if (value == 'null')  value = null;
  
  if (value && value.length > 0 && value[0] == '$')  value = eval(value.substr(1));
  
  query[p[1]] = value;
}

const protocol = cfg.protocol;
const socket = new sotradeClient.SoTradeConnection({
  url: query.wsurl || (protocol + '://' +
    (query.wshost || cfg.wshoste || cfg.wshost) + ':' +
    (query.wsport || cfg.wsporte || cfg.wsports[0])),
  logDevCheck: !query['q-quiet']
});

if (query['q-timeout']) {
  setTimeout(function() {
    console.log('timeout exceeded');
    process.exit(1);
  }, query['q-timeout'] * 1000);
}

socket.once('server-config').then(function() {
  return socket.emit(query.type, query);
}).then(function(data) {
  if (query.resultPath) {
    const path = String(query.resultPath).split('.');
    
    console.log(_.reduce(path, _.result, data));
  }
  
  if (!query.lurk)
    process.exit(0);
}).catch(e => console.trace(e));

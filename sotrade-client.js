(function () { "use strict";

var commonAPI = require('tradity-connection');
var sio = require('socket.io-client');
var fs = require('fs');
var https = require('https');
var _ = require('lodash');

function NodeSoTradeConnection (opt) {
  opt = opt || {};
  
  var cfg = opt.serverConfig || require('./config.js').config();
  
  if (!opt.url) {
    var port = cfg.wsporte || cfg.wsports[parseInt(Math.random() * cfg.wsports.length)];
    opt.url = cfg.protocol + '://' + (cfg.wshoste || cfg.wshost) + ':' + port;
  }
  
  try {
    if (!opt.messageSigner) {
      var SignedMessaging = require('./signedmsg.js').SignedMessaging;
      var smdb = new SignedMessaging();
      smdb.useConfig(cfg);
      opt.messageSigner = smdb;
    }
  } catch (e) {
    console.error(e);
  }

  try {
    opt.lzma = opt.lzma || new require('lzma-native').LZMA();
  } catch (e) {
    console.error(e);
  }
  
  opt.q = require('q');
  opt.q.longStackSupport = true;
  
  var socketopts = opt.socketopts || {};
  if (!socketopts.transports)
    socketopts.transports = ['websocket'];
  
  if (/^(https|wss)/.test(opt.url))
    socketopts.agent = new https.Agent(cfg.ssl);
  
  var url = opt.url;
  if (url && !opt.connect)
    opt.connect = function() { return sio.connect(url, socketopts); };
  
  if (typeof opt.logDevCheck == 'undefined')
    opt.logDevCheck = true;
  
  var ownVersion = 'SOTS0';
  try {
    ownVersion = require('./buildstamp.js');
  } catch(e) {
    console.warn(e);
  }
  
  opt.clientSoftwareVersion = opt.clientSoftwareVersion || ownVersion;
  return new commonAPI.SoTradeConnection(opt);
};

exports.SoTradeConnection = NodeSoTradeConnection;

})();

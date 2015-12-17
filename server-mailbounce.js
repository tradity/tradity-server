#!/usr/bin/env node

(function () { "use strict";

Error.stackTraceLimit = Infinity;

var debug = require('debug')('sotrade:mailbounce');
var minimist = require('minimist');
var MailParser = new require('mailparser').MailParser;
var sotradeClient = require('./sotrade-client.js');
var socket = new sotradeClient.SoTradeConnection({ logDevCheck: false });

var mail = null, serverConfigReceived = false, notifying = false;
var diagnostic_code = '', messageId = '';

function notifyServer() {
  debug('Notifying server', diagnostic_code, messageId);
  
  notifying = true;
  return socket.emit('email-bounced', { diagnostic_code: diagnostic_code, messageId: messageId }).then(function() {
    process.exit(0);
  });
}

var mailparser = new MailParser();
var options = minimist(process.argv.slice(2), {
  boolean: ['raw']
});

function handleMail(mail) {
  var attachments = mail.attachments;
  
  if (options.raw) {
    messageId = mail.headers['message-id'].replace(/^<|@.+$/g, '');
    diagnostic_code = 'Raw return to mail bounce handler script';
    
    if (!messageId)
      return process.exit(0);
    
    return notifyServer();
  }
  
  if (!attachments || !attachments.length)
    return process.exit(0);
  
  for (var i = 0; i < attachments.length; ++i) (function() {
    var attachment = attachments[i];
    
    var attachmentParser = new MailParser();
    
    attachmentParser.on('end', function(attachmentContent) {
      if (attachment.contentType == 'message/delivery-status') {
        var dsParser = new MailParser();
        
        dsParser.on('end', function(dsContent) {
          diagnostic_code = dsContent.headers['diagnostic-code'] || '[Unknown failure]';
          
          if (messageId)
            return notifyServer();
        });
        
        dsParser.end(attachmentContent.text);
      } else if (attachment.contentType == 'message/rfc822') {
        messageId = attachmentContent.headers['message-id'].replace(/^<|@.+$/g, '');
        
        if (diagnostic_code)
          return notifyServer();
      }
    });
    
    attachmentParser.end(attachment.content);
  })();
  
  setTimeout(function() {
    if (!notifying)
      process.exit(0);
  }, 5000);
}

mailparser.on('end', function(mail_) {
  debug('Have parsed mail');
  mail = mail_;

  if (serverConfigReceived)
    handleMail(mail);
});

process.stdin.pipe(mailparser);

socket.once('server-config').then(function() {
  debug('Have server config');
  serverConfigReceived = true;
  
  if (mail)
    handleMail(mail);
});

})();

